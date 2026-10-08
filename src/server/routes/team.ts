import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, passwordPolicyError } from '../auth/password.js';
import { audit, clinicRoute } from '../context.js';
import { hasPermission } from '../auth/rbac.js';
import { badRequest, conflict, forbidden, notFound } from '../http.js';
import { apptInScope, unitScope } from '../scope.js';

const idParam = z.object({ id: z.string().uuid() });
const ROLES = ['admin', 'unit_manager', 'receptionist', 'professional', 'finance', 'stock', 'marketing', 'auditor'] as const; // owner só é criado pelo Master

const unitIdsSchema = z.array(z.string().uuid()).max(50);
/** Substitui as unidades do usuário. Só gerente de unidade e profissional têm unidades; outros perfis não aceitam vínculo. */
async function setUnits(tx: import('../http.js').Tx, tenantId: string, userId: string, role: string, unitIds: string[]) {
  const ids = [...new Set(unitIds)];
  if (ids.length && role !== 'unit_manager' && role !== 'professional') throw badRequest('Só gerente de unidade e profissional são vinculados a unidades.');
  if (ids.length) {
    const ok = await tx.query('SELECT count(*)::int AS n FROM units WHERE id = ANY($1::uuid[])', [ids]);
    if (ok.rows[0].n !== ids.length) throw badRequest('Unidade inexistente.');
  }
  await tx.query('DELETE FROM user_units WHERE user_id = $1', [userId]);
  for (const u of ids) await tx.query('INSERT INTO user_units (tenant_id, user_id, unit_id) VALUES ($1,$2,$3)', [tenantId, userId, u]);
}

export function teamRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/users', { perm: 'users.manage' }, async (ctx) => {
    const r = await ctx.tx.query(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.totp_enabled AS "mfaEnabled", u.created_at AS "createdAt",
              COALESCE((SELECT array_agg(uu.unit_id ORDER BY uu.unit_id) FROM user_units uu WHERE uu.user_id = u.id), '{}') AS "unitIds"
         FROM users u ORDER BY u.name`);
    return { users: r.rows };
  });

  clinicRoute(app, 'POST', '/api/users', { perm: 'users.manage' }, async (ctx) => {
    const b = z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().toLowerCase().email().max(200),
      role: z.enum(ROLES),
      password: z.string().max(128),
      unitIds: unitIdsSchema.optional(),
    }).parse(ctx.req.body);
    const policy = passwordPolicyError(b.password);
    if (policy) throw badRequest(policy);
    const dup = await ctx.tx.query('SELECT 1 FROM users WHERE email = $1', [b.email]);
    if (dup.rowCount) throw conflict('Já existe um usuário com este e-mail.');
    const id = randomUUID();
    await ctx.tx.query(
      'INSERT INTO users (id, tenant_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, ctx.tenantId, b.email, b.name, await hashPassword(b.password), b.role]);
    if (b.unitIds?.length) await setUnits(ctx.tx, ctx.tenantId, id, b.role, b.unitIds);
    await audit(ctx, 'user.create', 'user', id, { role: b.role, units: b.unitIds?.length ?? 0 });
    return { id };
  });

  clinicRoute(app, 'PATCH', '/api/users/:id', { perm: 'users.manage' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({
      status: z.enum(['active', 'suspended']).optional(),
      role: z.enum(ROLES).optional(),
      password: z.string().max(128).optional(),
      resetMfa: z.literal(true).optional(),
      unitIds: unitIdsSchema.optional(),
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
    if (b.unitIds) {
      const roleNow = b.role ?? cur.rows[0].role;
      await setUnits(ctx.tx, ctx.tenantId, id, roleNow, b.unitIds);
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
        `SELECT count(*) FILTER (WHERE a.status NOT IN ('cancelled','no_show')) AS active,
                count(*) FILTER (WHERE a.status IN ('checked_in','called')) AS waiting
           FROM appointments a
          WHERE a.starts_at >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
            AND a.starts_at <  (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') + interval '1 day'
            AND ${apptInScope(1)}`, [await unitScope(ctx)]);
      out.appointmentsToday = Number(r.rows[0].active);
      out.waiting = Number(r.rows[0].waiting);
    }
    if (hasPermission(ctx.user.role, 'privacy.manage')) {
      const q = await ctx.tx.query(`SELECT count(*)::int AS open, count(*) FILTER (WHERE due_at < now())::int AS overdue FROM privacy_requests WHERE status IN ('open','in_progress')`);
      out.privacyOpen = q.rows[0].open; out.privacyOverdue = q.rows[0].overdue;
    }
    return out;
  });
}
