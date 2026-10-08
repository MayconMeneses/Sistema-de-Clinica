import '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withTenant } from '../db/tenant.js';
import { loadEntitlements } from '../modules/entitlements/load.js';
import { config } from './config.js';
import { appPool, platformPool } from './db.js';
import { forbidden, HttpError, sha256, unauthorized, type Tx } from './http.js';
import { hasPermission, type Permission } from './auth/rbac.js';

export const CLINIC_COOKIE = 'cs';
export const MASTER_COOKIE = 'ms';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function cookieOptions(path: string, hours: number) {
  return { httpOnly: true, secure: config.isProd, sameSite: 'strict' as const, path, maxAge: hours * 3600 };
}

export interface ClinicCtx {
  tx: Tx;
  tenantId: string;
  tenantName: string;
  user: { id: string; name: string; email: string; role: string };
  sessionId: string;
  entitlements: Set<string>;
  req: FastifyRequest;
}

interface RouteOpts { cap?: string; perm?: Permission; bodyLimit?: number }

/** Registro das rotas autenticadas, usado por testes que provam que TODA rota exige sessão e permissão. */
export const routeRegistry: { kind: 'clinic' | 'master'; method: string; url: string; perm?: Permission; cap?: string }[] = [];
type Handler<C> = (ctx: C, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * Rota autenticada da clínica. Em UMA transação: define o tenant (vindo da sessão, não do cliente),
 * valida sessão/usuário/versão, aplica RBAC e entitlement, e só então roda o handler.
 */
export function clinicRoute(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts: RouteOpts,
  handler: Handler<ClinicCtx>,
) {
  routeRegistry.push({ kind: 'clinic', method, url, perm: opts.perm, cap: opts.cap });
  app.route({
    method, url,
    ...(opts.bodyLimit ? { bodyLimit: opts.bodyLimit } : {}),
    handler: async (req, reply) => {
      const raw = req.cookies[CLINIC_COOKIE];
      const dot = raw?.indexOf('.') ?? -1;
      if (!raw || dot < 1) throw unauthorized();
      const tenantHint = raw.slice(0, dot);
      const secret = raw.slice(dot + 1);
      if (!UUID_RE.test(tenantHint) || !secret) throw unauthorized();

      try {
        return await withTenant(appPool, tenantHint, async (tx) => {
          const ctx = await authenticate(tx, tenantHint, secret, req);
          req.alertTenant = { id: ctx.tenantId, name: ctx.tenantName };
          if (opts.perm && !hasPermission(ctx.user.role, opts.perm)) throw forbidden();
          if (opts.cap && !ctx.entitlements.has(opts.cap)) {
            throw new HttpError(403, 'Este recurso não está incluído no plano contratado.', 'capability_unavailable');
          }
          return handler(ctx, req, reply);
        });
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) reply.clearCookie(CLINIC_COOKIE, cookieOptions('/', 0));
        throw e;
      }
    },
  });
}

async function authenticate(tx: pg.PoolClient, tenantId: string, secret: string, req: FastifyRequest): Promise<ClinicCtx> {
  const r = await tx.query<{
    sid: string; sv: number; expires_at: Date; revoked_at: Date | null;
    id: string; name: string; email: string; role: string; status: string; session_version: number;
  }>(
    `SELECT s.id AS sid, s.session_version AS sv, s.expires_at, s.revoked_at,
            u.id, u.name, u.email, u.role, u.status, u.session_version
       FROM sessions s JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
      WHERE s.token_hash = $1`,
    [sha256(secret)],
  );
  const row = r.rows[0];
  if (!row || row.revoked_at || row.expires_at.getTime() < Date.now()
      || row.status !== 'active' || row.sv !== row.session_version) throw unauthorized();

  const t = await tx.query<{ name: string; status: string }>('SELECT name, status FROM tenants');
  const tenant = t.rows[0];
  if (!tenant) throw unauthorized();
  if (tenant.status !== 'active') throw new HttpError(403, 'Clínica suspensa. Contate o suporte.', 'tenant_suspended');

  return {
    tx, tenantId, tenantName: tenant.name, sessionId: row.sid, req,
    user: { id: row.id, name: row.name, email: row.email, role: row.role },
    entitlements: await loadEntitlements(tx),
  };
}

export async function audit(ctx: ClinicCtx, action: string, entityType: string, entityId?: string, metadata: object = {}) {
  await ctx.tx.query(
    `INSERT INTO audit_events (tenant_id, actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ctx.tenantId, ctx.user.id, action, entityType, entityId ?? null, JSON.stringify({ ...metadata, ip: ctx.req.ip })],
  );
}

// ---------------------------------------------------------------- MASTER
export interface MasterCtx {
  db: pg.PoolClient;
  operator: { id: string; name: string; email: string };
  sessionId: string;
  req: FastifyRequest;
}

export function masterRoute(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  handler: Handler<MasterCtx>,
) {
  routeRegistry.push({ kind: 'master', method, url });
  app.route({
    method, url,
    handler: async (req, reply) => {
      const secret = req.cookies[MASTER_COOKIE];
      if (!secret) throw unauthorized();
      const db = await platformPool.connect();
      try {
        await db.query('BEGIN');
        const r = await db.query<{ sid: string; id: string; name: string; email: string; status: string; expires_at: Date; revoked_at: Date | null }>(
          `SELECT s.id AS sid, s.expires_at, s.revoked_at, u.id, u.name, u.email, u.status
             FROM platform_sessions s JOIN platform_users u ON u.id = s.user_id WHERE s.token_hash = $1`,
          [sha256(secret)],
        );
        const row = r.rows[0];
        if (!row || row.revoked_at || row.expires_at.getTime() < Date.now() || row.status !== 'active') {
          reply.clearCookie(MASTER_COOKIE, cookieOptions('/api/master', 0));
          throw unauthorized();
        }
        const out = await handler({ db, operator: { id: row.id, name: row.name, email: row.email }, sessionId: row.sid, req }, req, reply);
        await db.query('COMMIT');
        return out;
      } catch (e) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        db.release();
      }
    },
  });
}
