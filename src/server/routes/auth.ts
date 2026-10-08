import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../db/tenant.js';
import { consumeTotp } from '../auth/mfa.js';
import { permissionsFor } from '../auth/rbac.js';
import { hashPassword, passwordPolicyError, verifyPassword } from '../auth/password.js';
import { DbRateLimiter } from '../auth/rate-limit.js';
import { generateSecret, otpauthUri } from '../auth/totp.js';
import { audit, clinicRoute, CLINIC_COOKIE, cookieOptions } from '../context.js';
import { config } from '../config.js';
import { encryptSecret } from '../crypto.js';
import { appPool } from '../db.js';
import { unitScope } from '../scope.js';
import { badRequest, conflict, HttpError, newSecret, sha256, unauthorized } from '../http.js';

const limiter = new DbRateLimiter(appPool);
const GENERIC = 'Clínica, e-mail ou senha inválidos.';

const loginBody = z.object({
  clinic: z.string().trim().toLowerCase().min(2).max(63),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
  code: z.string().trim().max(10).optional(),
});

type LoginOutcome = { kind: 'fail' } | { kind: 'mfa_required' } | { kind: 'ok'; cookie: string };

export function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const { clinic, email, password, code } = loginBody.parse(req.body);
    const key = `${req.ip}|${clinic}|${email}`;
    if (await limiter.tooMany(key)) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'rate_limited');

    const dir = await appPool.query<{ tenant_id: string; status: string }>(
      'SELECT tenant_id, status FROM tenant_directory WHERE slug = $1', [clinic]);
    const entry = dir.rows[0];
    if (!entry || entry.status !== 'active') {
      await verifyPassword(password, null);
      await limiter.record(key);
      throw unauthorized(GENERIC);
    }

    const outcome = await withTenant<LoginOutcome>(appPool, entry.tenant_id, async (tx) => {
      const u = await tx.query<{ id: string; password_hash: string; status: string; session_version: number; totp_enabled: boolean; totp_secret: string | null }>(
        'SELECT id, password_hash, status, session_version, totp_enabled, totp_secret FROM users WHERE email = $1', [email]);
      const user = u.rows[0];
      const ok = await verifyPassword(password, user?.password_hash);
      const fail = async (action: string): Promise<LoginOutcome> => {
        await tx.query(
          `INSERT INTO audit_events (tenant_id, actor_id, action, entity_type, metadata) VALUES ($1, $2, $3, 'user', $4)`,
          [entry.tenant_id, user?.id ?? null, action, JSON.stringify({ ip: req.ip })]);
        return { kind: 'fail' };
      };
      if (!user || !ok || user.status !== 'active') return fail('auth.login_failed');
      if (user.totp_enabled) {
        if (!code) return { kind: 'mfa_required' };
        if (!user.totp_secret || !(await consumeTotp(tx, 'users', user.id, user.totp_secret, code))) return fail('auth.mfa_failed');
      }
      const secret = newSecret();
      await tx.query(
        `INSERT INTO sessions (id, tenant_id, user_id, token_hash, session_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
        [randomUUID(), entry.tenant_id, user.id, sha256(secret), user.session_version, config.clinicSessionHours]);
      await tx.query(
        `INSERT INTO audit_events (tenant_id, actor_id, action, entity_type, entity_id, metadata) VALUES ($1, $2, 'auth.login', 'user', $3, $4)`,
        [entry.tenant_id, user.id, user.id, JSON.stringify({ ip: req.ip, mfa: user.totp_enabled })]);
      return { kind: 'ok', cookie: `${entry.tenant_id}.${secret}` };
    });

    if (outcome.kind === 'mfa_required') throw new HttpError(401, 'Informe o código do aplicativo autenticador.', 'mfa_required');
    if (outcome.kind === 'fail') { await limiter.record(key); throw unauthorized(code ? 'Código ou credenciais inválidos.' : GENERIC); }
    await limiter.reset(key);
    reply.setCookie(CLINIC_COOKIE, outcome.cookie, cookieOptions('/', config.clinicSessionHours));
    return { ok: true };
  });

  clinicRoute(app, 'POST', '/api/auth/logout', {}, async (ctx, _req, reply) => {
    await ctx.tx.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [ctx.sessionId]);
    await audit(ctx, 'auth.logout', 'user', ctx.user.id);
    reply.clearCookie(CLINIC_COOKIE, cookieOptions('/', 0));
    return { ok: true };
  });

  clinicRoute(app, 'GET', '/api/me', {}, async (ctx) => {
    const m = await ctx.tx.query<{ totp_enabled: boolean }>('SELECT totp_enabled FROM users WHERE id = $1', [ctx.user.id]);
    return {
      user: ctx.user,
      clinic: { name: ctx.tenantName },
      permissions: permissionsFor(ctx.user.role),
      entitlements: [...ctx.entitlements].sort(),
      mfaEnabled: m.rows[0]?.totp_enabled ?? false,
      unitScope: await unitScope(ctx), // null = sem restrição; lista (talvez vazia) = só estas unidades
    };
  });

  clinicRoute(app, 'POST', '/api/me/password', {}, async (ctx, _req, reply) => {
    const body = z.object({ current: z.string().max(200), next: z.string().max(200) }).parse(ctx.req.body);
    const policy = passwordPolicyError(body.next);
    if (policy) throw badRequest(policy);
    const r = await ctx.tx.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [ctx.user.id]);
    if (!(await verifyPassword(body.current, r.rows[0]?.password_hash))) throw badRequest('Senha atual incorreta.');
    const upd = await ctx.tx.query<{ session_version: number }>(
      'UPDATE users SET password_hash = $1, session_version = session_version + 1 WHERE id = $2 RETURNING session_version',
      [await hashPassword(body.next), ctx.user.id]);
    // Revoga todas as sessões antigas e emite uma nova para este dispositivo.
    await ctx.tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [ctx.user.id]);
    const secret = newSecret();
    await ctx.tx.query(
      `INSERT INTO sessions (id, tenant_id, user_id, token_hash, session_version, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
      [randomUUID(), ctx.tenantId, ctx.user.id, sha256(secret), upd.rows[0]!.session_version, config.clinicSessionHours]);
    await audit(ctx, 'auth.password_changed', 'user', ctx.user.id);
    reply.setCookie(CLINIC_COOKIE, `${ctx.tenantId}.${secret}`, cookieOptions('/', config.clinicSessionHours));
    return { ok: true };
  });

  // ------------------------------------------------------------ MFA da clínica
  const mfaKey = (ctx: { tenantId: string; user: { id: string } }) => `mfa|${ctx.tenantId}|${ctx.user.id}`;

  clinicRoute(app, 'POST', '/api/me/mfa/setup', {}, async (ctx) => {
    const { password } = z.object({ password: z.string().max(200) }).parse(ctx.req.body);
    if (await limiter.tooMany(mfaKey(ctx))) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'rate_limited');
    const r = await ctx.tx.query<{ password_hash: string; totp_enabled: boolean }>('SELECT password_hash, totp_enabled FROM users WHERE id = $1', [ctx.user.id]);
    if (r.rows[0]?.totp_enabled) throw conflict('A autenticação em dois fatores já está ativa.');
    if (!(await verifyPassword(password, r.rows[0]?.password_hash))) { await limiter.record(mfaKey(ctx)); throw badRequest('Senha incorreta.'); }
    const secret = generateSecret();
    await ctx.tx.query('UPDATE users SET totp_secret = $1, totp_enabled = false, totp_last_step = NULL WHERE id = $2', [encryptSecret(secret), ctx.user.id]);
    await audit(ctx, 'mfa.setup_started', 'user', ctx.user.id);
    return { secret, otpauth: otpauthUri(secret, ctx.user.email) };
  });

  clinicRoute(app, 'POST', '/api/me/mfa/enable', {}, async (ctx) => {
    const { code } = z.object({ code: z.string().trim().max(10) }).parse(ctx.req.body);
    if (await limiter.tooMany(mfaKey(ctx))) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'rate_limited');
    const r = await ctx.tx.query<{ totp_secret: string | null; totp_enabled: boolean }>('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [ctx.user.id]);
    const row = r.rows[0];
    if (!row?.totp_secret || row.totp_enabled) throw conflict('Inicie a configuração do MFA primeiro.');
    if (!(await consumeTotp(ctx.tx, 'users', ctx.user.id, row.totp_secret, code))) { await limiter.record(mfaKey(ctx)); throw badRequest('Código inválido. Confira o horário do aparelho e tente de novo.'); }
    await ctx.tx.query('UPDATE users SET totp_enabled = true WHERE id = $1', [ctx.user.id]);
    await audit(ctx, 'mfa.enabled', 'user', ctx.user.id);
    return { ok: true };
  });

  clinicRoute(app, 'POST', '/api/me/mfa/disable', {}, async (ctx) => {
    const b = z.object({ password: z.string().max(200), code: z.string().trim().max(10) }).parse(ctx.req.body);
    if (await limiter.tooMany(mfaKey(ctx))) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'rate_limited');
    const r = await ctx.tx.query<{ password_hash: string; totp_secret: string | null; totp_enabled: boolean }>('SELECT password_hash, totp_secret, totp_enabled FROM users WHERE id = $1', [ctx.user.id]);
    const row = r.rows[0];
    if (!row?.totp_enabled || !row.totp_secret) throw conflict('A autenticação em dois fatores não está ativa.');
    const pwOk = await verifyPassword(b.password, row.password_hash);
    const codeOk = pwOk && (await consumeTotp(ctx.tx, 'users', ctx.user.id, row.totp_secret, b.code));
    if (!pwOk || !codeOk) { await limiter.record(mfaKey(ctx)); throw badRequest('Senha ou código inválidos.'); }
    await ctx.tx.query('UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_last_step = NULL WHERE id = $1', [ctx.user.id]);
    await audit(ctx, 'mfa.disabled', 'user', ctx.user.id);
    return { ok: true };
  });
}
