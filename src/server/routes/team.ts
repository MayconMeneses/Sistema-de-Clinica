import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, passwordPolicyError } from '../auth/password.js';
import { audit, clinicRoute } from '../context.js';
import { badRequest, conflict, forbidden, notFound } from '../http.js';

const idParam = z.object({ id: z.string().uuid() });
const ROLES = ['admin', 'receptionist', 'professional', 'finance'] as const; // owner só é criado pelo Master

export function teamRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/users', { perm: 'users.manage' }, async (ctx) => {
    const r = await ctx.tx.query('SELECT id, name, email, role, status, totp_enabled AS "mfaEnabled", created_at AS "createdAt" FROM users ORDER BY name');
    return { users: r.rows };
  });

  clinicRoute(app, 'POST', '/api/users', { perm: 'users.manage' }, async (ctx) => {
    const b = z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().toLowerCase().email().max(200),
      role: z.enum(ROLES),
      password: z.string().max(128),
    }).parse(ctx.req.body);
    const policy = passwordPolicyError(b.password);
    if (policy) throw badRequest(policy);
    const dup = await ctx.tx.query('SELECT 1 FROM users WHERE email = $1', [b.email]);
    if (dup.rowCount) throw conflict('Já existe um usuário com este e-mail.');
    const id = randomUUID();
    await ctx.tx.query(
      'INSERT INTO users (id, tenant_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, ctx.tenantId, b.email, b.name, await hashPassword(b.password), b.role]);
    await audit(ctx, 'user.create', 'user', id, { role: b.role });
    return { id };
  });

  clinicRoute(app, 'PATCH', '/api/users/:id', { perm: 'users.manage' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({
      status: z.enum(['active', 'suspended']).optional(),
      role: z.enum(ROLES).optional(),
      password: z.string().max(128).optional(),
      resetMfa: z.literal(true).optional(),
    }).parse(ctx.req.body);
    if (id === ctx.user.id) throw forbidden('Você não pode alterar a própria conta aqui.');
    const cur = await ctx.tx.query<{ role: string }>('SELECT role FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Usuário não encontrado.');
    if (cur.rows[0].role === 'owner') throw forbidden('O proprietário só é alterado pelo suporte da plataforma.');
    if (b.password !== undefined) {
      const policy = passwordPolicyError(b.password);
      if (policy) throw badRequest(policy);
    }
    let bump = false;
    if (b.status) { await ctx.tx.query('UPDATE users SET status = $1 WHERE id = $2', [b.status, id]); bump = b.status === 'suspended'; }
    if (b.role) { await ctx.tx.query('UPDATE users SET role = $1 WHERE id = $2', [b.role, id]); bump = true; }
    if (b.password) { await ctx.tx.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(b.password), id]); bump = true; }
    if (b.resetMfa) {
      await ctx.tx.query('UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_last_step = NULL WHERE id = $1', [id]);
      bump = true;
    }
    if (bump) { // acesso anterior deixa de valer imediatamente
      await ctx.tx.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [id]);
      await ctx.tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    await audit(ctx, 'user.update', 'user', id, { status: b.status, role: b.role, passwordReset: !!b.password, mfaReset: !!b.resetMfa });
    return { ok: true };
  });

  clinicRoute(app, 'GET', '/api/audit', { perm: 'audit.read' }, async (ctx) => {
    const r = await ctx.tx.query(
      `SELECT e.id, e.occurred_at AS "occurredAt", e.action, e.entity_type AS "entityType", e.entity_id AS "entityId", u.name AS "actorName"
         FROM audit_events e LEFT JOIN users u ON u.tenant_id = e.tenant_id AND u.id = e.actor_id
        ORDER BY e.occurred_at DESC LIMIT 100`);
    return { events: r.rows };
  });

  clinicRoute(app, 'GET', '/api/dashboard', {}, async (ctx) => {
    const has = (c: string) => ctx.entitlements.has(c);
    const out: Record<string, unknown> = {};
    if (has('patient.registry')) out.patients = Number((await ctx.tx.query('SELECT count(*) FROM patients')).rows[0].count);
    if (has('schedule.core')) {
      const r = await ctx.tx.query(
        `SELECT count(*) FILTER (WHERE status NOT IN ('cancelled','no_show')) AS active,
                count(*) FILTER (WHERE status IN ('checked_in','called')) AS waiting
           FROM appointments
          WHERE starts_at >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
            AND starts_at <  (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') + interval '1 day'`);
      out.appointmentsToday = Number(r.rows[0].active);
      out.waiting = Number(r.rows[0].waiting);
    }
    return out;
  });
}
