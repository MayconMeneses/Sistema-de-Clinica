import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../db/tenant.js';
import { consumeTotp } from '../auth/mfa.js';
import { permissionsFor } from '../auth/rbac.js';
import { hashPassword, needsRehash, passwordPolicyError, verifyPassword } from '../auth/password.js';
import { DbRateLimiter } from '../auth/rate-limit.js';
import { generateSecret, otpauthUri } from '../auth/totp.js';
import { audit, clinicRoute, CLINIC_COOKIE, cookieOptions } from '../context.js';
import { config } from '../config.js';
import { encryptSecret } from '../crypto.js';
import { RESET_MINUTES } from '../../modules/communications/handler.js';
import { appPool } from '../db.js';
import { unitScope } from '../scope.js';
import { badRequest, conflict, HttpError, newSecret, sha256, unauthorized } from '../http.js';

const limiter = new DbRateLimiter(appPool);
// Além do limite por IP+clínica+e-mail: limite por IP (varredura de várias contas) e por conta no código MFA (varredura a partir de vários IPs).
const ipLimiter = { tooMany: (k: string) => new DbRateLimiter(appPool, Number(process.env.LOGIN_IP_MAX ?? 30), 15).tooMany(k), record: (k: string) => limiter.record(k) };
const mfaLimiter = new DbRateLimiter(appPool, 10, 15);
const GENERIC = 'Clínica, e-mail ou senha inválidos.';

const loginBody = z.object({
  clinic: z.string().trim().toLowerCase().min(2).max(63),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
  code: z.string().trim().max(10).optional(),
});

type LoginOutcome = { kind: 'fail' } | { kind: 'locked' } | { kind: 'mfa_required' } | { kind: 'ok'; cookie: string };

export function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const { clinic, email, password, code } = loginBody.parse(req.body);
    const key = `${req.ip}|${clinic}|${email}`;
    const ipKey = `ip|${req.ip}`;
    if (await limiter.tooMany(key) || await ipLimiter.tooMany(ipKey)) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'rate_limited');

    const dir = await appPool.query<{ tenant_id: string; status: string }>(
      'SELECT tenant_id, status FROM tenant_directory WHERE slug = $1', [clinic]);
    const entry = dir.rows[0];
    if (!entry || entry.status !== 'active') {
      await verifyPassword(password, null);
      await limiter.record(key); await ipLimiter.record(ipKey);
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
      const mfaKey = `mfa|${entry.tenant_id}|${user.id}`;
      if (user.totp_enabled) {
        if (!code) return { kind: 'mfa_required' };
        if (await mfaLimiter.tooMany(mfaKey)) return { kind: 'locked' };
        if (!user.totp_secret || !(await consumeTotp(tx, 'users', user.id, user.totp_secret, code))) { await mfaLimiter.record(mfaKey); return fail('auth.mfa_failed'); }
        await mfaLimiter.reset(mfaKey);
      }
      if (needsRehash(user.password_hash)) await tx.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(password), user.id]);
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
    if (outcome.kind === 'locked') throw new HttpError(429, 'Muitas tentativas de código. Aguarde alguns minutos.', 'rate_limited');
    if (outcome.kind === 'fail') { await limiter.record(key); await ipLimiter.record(ipKey); throw unauthorized(code ? 'Código ou credenciais inválidos.' : GENERIC); }
    await limiter.reset(key);
    reply.setCookie(CLINIC_COOKIE, outcome.cookie, cookieOptions('/', config.clinicSessionHours));
    return { ok: true };
  });

  // ------------------------------------------------------------ recuperação de senha por e-mail
  // A resposta é sempre a mesma, exista ou não o e-mail (não revela quem tem conta). O link vale RESET_MINUTES e só uma vez.
  const FORGOT_OK = { ok: true, message: 'Se o e-mail estiver cadastrado, enviamos um link para redefinir a senha. Ele vale por 30 minutos.' };

  app.post('/api/auth/forgot', async (req) => {
    const { clinic, email } = z.object({
      clinic: z.string().trim().toLowerCase().min(2).max(63),
      email: z.string().trim().toLowerCase().email().max(200),
    }).parse(req.body);
    const key = `forgot|${req.ip}|${clinic}|${email}`;
    if (await limiter.tooMany(key)) return FORGOT_OK;           // acima do limite: nada é criado, mas a resposta não muda
    await limiter.record(key);
    const dir = await appPool.query<{ tenant_id: string; status: string }>('SELECT tenant_id, status FROM tenant_directory WHERE slug = $1', [clinic]);
    const entry = dir.rows[0];
    if (!entry || entry.status !== 'active') return FORGOT_OK;
    await withTenant(appPool, entry.tenant_id, async (tx) => {
      const u = await tx.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND status = 'active'`, [email]);
      const user = u.rows[0];
      if (!user) return;
      await tx.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]); // só o link mais recente vale
      const token = newSecret();
      const r = await tx.query<{ id: string }>(
        `INSERT INTO password_resets (tenant_id, user_id, token_hash, token_enc, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5)) RETURNING id`,
        [entry.tenant_id, user.id, sha256(token), encryptSecret(token), RESET_MINUTES]);
      await tx.query(
        `INSERT INTO outbox_events (tenant_id, topic, payload, idempotency_key) VALUES ($1,'message.send',$2,$3)`,
        [entry.tenant_id, JSON.stringify({ template: 'password_reset', channel: 'email', resetId: r.rows[0]!.id }), `password_reset:${r.rows[0]!.id}`]);
      await tx.query(
        `INSERT INTO audit_events (tenant_id, actor_id, action, entity_type, entity_id, metadata) VALUES ($1, NULL, 'auth.password_reset_requested', 'user', $2, $3)`,
        [entry.tenant_id, user.id, JSON.stringify({ ip: req.ip })]);
    });
    return FORGOT_OK;
  });

  app.post('/api/auth/reset', async (req) => {
    const b = z.object({
      clinic: z.string().trim().toLowerCase().min(2).max(63),
      token: z.string().trim().min(20).max(200),
      password: z.string().max(200),
    }).parse(req.body);
    const key = `reset|${req.ip}|${b.clinic}`;
    if (await limiter.tooMany(key)) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'rate_limited');
    const policy = passwordPolicyError(b.password);
    if (policy) throw badRequest(policy);
    const bad = async () => { await limiter.record(key); throw badRequest('Link inválido ou expirado. Peça um novo link na tela de entrada.'); };
    const dir = await appPool.query<{ tenant_id: string; status: string }>('SELECT tenant_id, status FROM tenant_directory WHERE slug = $1', [b.clinic]);
    const entry = dir.rows[0];
    if (!entry || entry.status !== 'active') return bad();
    const hash = await hashPassword(b.password);
    const done = await withTenant(appPool, entry.tenant_id, async (tx) => {
      const r = await tx.query<{ id: string; user_id: string }>(
        `SELECT r.id, r.user_id FROM password_resets r JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
          WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() AND u.status = 'active' FOR UPDATE OF r`, [sha256(b.token)]);
      const row = r.rows[0];
      if (!row) return false;
      await tx.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [row.user_id]);
      await tx.query('UPDATE users SET password_hash = $1, session_version = session_version + 1 WHERE id = $2', [hash, row.user_id]);
      await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);   // derruba todas as sessões
      await tx.query(
        `INSERT INTO audit_events (tenant_id, actor_id, action, entity_type, entity_id, metadata) VALUES ($1, $2::uuid, 'auth.password_reset_done', 'user', $2::text, $3)`,
        [entry.tenant_id, row.user_id, JSON.stringify({ ip: req.ip })]);
      return true;
    });
    if (!done) return bad();
    await limiter.reset(key);
    return { ok: true, message: 'Senha alterada. Entre com a nova senha. Se você usa verificação em duas etapas, ela continua exigida.' };
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
