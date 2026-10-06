import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../db/tenant.js';
import { permissionsFor } from '../auth/rbac.js';
import { hashPassword, passwordPolicyError, verifyPassword } from '../auth/password.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { audit, clinicRoute, CLINIC_COOKIE, cookieOptions } from '../context.js';
import { config } from '../config.js';
import { appPool } from '../db.js';
import { badRequest, HttpError, newSecret, sha256, unauthorized } from '../http.js';

const limiter = new RateLimiter(5, 15 * 60 * 1000);
const GENERIC = 'Clínica, e-mail ou senha inválidos.';

const loginBody = z.object({
  clinic: z.string().trim().toLowerCase().min(2).max(63),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

export function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const { clinic, email, password } = loginBody.parse(req.body);
    const key = `${req.ip}|${clinic}|${email}`;
    if (limiter.tooMany(key)) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'rate_limited');

    const dir = await appPool.query<{ tenant_id: string; status: string }>(
      'SELECT tenant_id, status FROM tenant_directory WHERE slug = $1', [clinic]);
    const entry = dir.rows[0];
    if (!entry || entry.status !== 'active') {
      await verifyPassword(password, null);
      limiter.record(key);
      throw unauthorized(GENERIC);
    }

    const outcome = await withTenant(appPool, entry.tenant_id, async (tx) => {
      const u = await tx.query<{ id: string; password_hash: string; status: string; session_version: number }>(
        'SELECT id, password_hash, status, session_version FROM users WHERE email = $1', [email]);
      const user = u.rows[0];
      const ok = await verifyPassword(password, user?.password_hash);
      if (!user || !ok || user.status !== 'active') {
        await tx.query(
          `INSERT INTO audit_events (tenant_id, actor_id, action, entity_type, metadata) VALUES ($1, $2, 'auth.login_failed', 'user', $3)`,
          [entry.tenant_id, user?.id ?? null, JSON.stringify({ ip: req.ip })]);
        return null;
      }
      const secret = newSecret();
      await tx.query(
        `INSERT INTO sessions (id, tenant_id, user_id, token_hash, session_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
        [randomUUID(), entry.tenant_id, user.id, sha256(secret), user.session_version, config.clinicSessionHours]);
      await tx.query(
        `INSERT INTO audit_events (tenant_id, actor_id, action, entity_type, entity_id, metadata) VALUES ($1, $2, 'auth.login', 'user', $3, $4)`,
        [entry.tenant_id, user.id, user.id, JSON.stringify({ ip: req.ip })]);
      return `${entry.tenant_id}.${secret}`;
    });

    if (!outcome) { limiter.record(key); throw unauthorized(GENERIC); }
    limiter.reset(key);
    reply.setCookie(CLINIC_COOKIE, outcome, cookieOptions('/', config.clinicSessionHours));
    return { ok: true };
  });

  clinicRoute(app, 'POST', '/api/auth/logout', {}, async (ctx, _req, reply) => {
    await ctx.tx.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [ctx.sessionId]);
    await audit(ctx, 'auth.logout', 'user', ctx.user.id);
    reply.clearCookie(CLINIC_COOKIE, cookieOptions('/', 0));
    return { ok: true };
  });

  clinicRoute(app, 'GET', '/api/me', {}, async (ctx) => ({
    user: ctx.user,
    clinic: { name: ctx.tenantName },
    permissions: permissionsFor(ctx.user.role),
    entitlements: [...ctx.entitlements].sort(),
  }));

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
}
