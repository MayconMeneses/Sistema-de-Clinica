import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveEntitlements, type TenantStatus } from '../../modules/entitlements/resolve.js';
import { hashPassword, passwordPolicyError, verifyPassword } from '../auth/password.js';
import { consumeTotp } from '../auth/mfa.js';
import { DbRateLimiter } from '../auth/rate-limit.js';
import { config } from '../config.js';
import { cookieOptions, MASTER_COOKIE, masterRoute, type MasterCtx } from '../context.js';
import { platformPool } from '../db.js';
import { getNotifier, locateError, notify } from '../../ops/alerts.js';
import { integrationHealth, LIVE_PROVIDERS } from '../../integrations/registry.js';
import { badRequest, conflict, forbidden, HttpError, newSecret, notFound, sha256, unauthorized } from '../http.js';

const limiter = new DbRateLimiter(platformPool);
const justification = z.string().trim().min(5, 'Informe a justificativa (mín. 5 caracteres).').max(500);

async function platformAudit(c: MasterCtx, action: string, tenantId: string | null, why: string, metadata: object = {}) {
  await c.db.query(
    `INSERT INTO platform_audit_events (operator_id, action, tenant_id, justification, metadata) VALUES ($1,$2,$3,$4,$5)`,
    [c.operator.email, action, tenantId, why, JSON.stringify({ ...metadata, ip: c.req.ip })]);
}

/** Reautenticação (MFA) para ações críticas. Cada código vale uma vez (anti-replay). */
async function requireFreshMfa(c: MasterCtx, code: string | undefined) {
  const r = await c.db.query<{ totp_secret: string }>('SELECT totp_secret FROM platform_users WHERE id = $1', [c.operator.id]);
  if (!code || !r.rows[0] || !(await consumeTotp(c.db, 'platform_users', c.operator.id, r.rows[0].totp_secret, code))) {
    throw forbidden('Código MFA inválido ou já utilizado. Aguarde o próximo código do aplicativo.');
  }
}

export function masterRoutes(app: FastifyInstance) {
  app.post('/api/master/login', async (req, reply) => {
    const body = z.object({
      email: z.string().trim().toLowerCase().email().max(200),
      password: z.string().min(1).max(200),
      code: z.string().trim().max(10),
    }).parse(req.body);
    const key = `${req.ip}|master|${body.email}`;
    if (await limiter.tooMany(key)) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'rate_limited');

    const u = await platformPool.query<{ id: string; password_hash: string; totp_secret: string; status: string }>(
      'SELECT id, password_hash, totp_secret, status FROM platform_users WHERE email = $1', [body.email]);
    const user = u.rows[0];
    const pwOk = await verifyPassword(body.password, user?.password_hash);
    const mfaOk = !!user && pwOk && (await consumeTotp(platformPool, 'platform_users', user.id, user.totp_secret, body.code));
    if (!user || !pwOk || !mfaOk || user.status !== 'active') {
      await limiter.record(key);
      await platformPool.query(
        `INSERT INTO platform_audit_events (operator_id, action, justification, metadata) VALUES ($1,'master.login_failed','tentativa de login',$2)`,
        [body.email, JSON.stringify({ ip: req.ip })]);
      throw unauthorized('E-mail, senha ou código MFA inválidos.');
    }
    await limiter.reset(key);
    const secret = newSecret();
    await platformPool.query(
      `INSERT INTO platform_sessions (user_id, token_hash, expires_at) VALUES ($1,$2, now() + make_interval(hours => $3))`,
      [user.id, sha256(secret), config.masterSessionHours]);
    await platformPool.query(
      `INSERT INTO platform_audit_events (operator_id, action, justification, metadata) VALUES ($1,'master.login','login com MFA',$2)`,
      [body.email, JSON.stringify({ ip: req.ip })]);
    reply.setCookie(MASTER_COOKIE, secret, cookieOptions('/api/master', config.masterSessionHours));
    return { ok: true };
  });

  masterRoute(app, 'POST', '/api/master/logout', async (c, _req, reply) => {
    await c.db.query('UPDATE platform_sessions SET revoked_at = now() WHERE id = $1', [c.sessionId]);
    reply.clearCookie(MASTER_COOKIE, cookieOptions('/api/master', 0));
    return { ok: true };
  });

  masterRoute(app, 'GET', '/api/master/me', async (c) => ({ operator: c.operator }));

  masterRoute(app, 'GET', '/api/master/overview', async (c) => {
    const plans = await c.db.query('SELECT code, name FROM plans ORDER BY sort_order');
    const caps = await c.db.query('SELECT code, description, globally_available AS "globallyAvailable", depends_on AS "dependsOn" FROM capabilities ORDER BY code');
    const pcaps = await c.db.query('SELECT plan_code, capability_code FROM plan_capabilities');
    const tenants = await c.db.query('SELECT id, slug, name, status, plan_code AS "planCode", created_at AS "createdAt" FROM tenants ORDER BY created_at DESC');
    const overrides = await c.db.query('SELECT tenant_id, capability_code, mode, reason FROM tenant_entitlement_overrides');
    const owners = await c.db.query('SELECT tenant_id, name, email, totp_enabled FROM users WHERE role = \'owner\'');
    const catalog = caps.rows.map((r) => ({ code: r.code, globallyAvailable: r.globallyAvailable, dependsOn: r.dependsOn }));
    return {
      plans: plans.rows,
      capabilities: caps.rows,
      tenants: tenants.rows.map((t) => {
        const ov = overrides.rows.filter((o) => o.tenant_id === t.id);
        const effective = resolveEntitlements({
          tenantStatus: t.status as TenantStatus,
          planCapabilities: pcaps.rows.filter((p) => p.plan_code === t.planCode).map((p) => p.capability_code),
          overrides: ov.map((o) => ({ capability: o.capability_code, mode: o.mode })),
          catalog,
        });
        return { ...t, owner: owners.rows.filter((o) => o.tenant_id === t.id).map((o) => ({ name: o.name, email: o.email, mfaEnabled: o.totp_enabled }))[0] ?? null, overrides: ov.map((o) => ({ capability: o.capability_code, mode: o.mode, reason: o.reason })), effective: [...effective].sort() };
      }),
    };
  });

  masterRoute(app, 'POST', '/api/master/tenants', async (c, req) => {
    const b = z.object({
      name: z.string().trim().min(2).max(120),
      slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Use letras minúsculas, números e hífen.'),
      planCode: z.string().min(1).max(40),
      ownerName: z.string().trim().min(2).max(120),
      ownerEmail: z.string().trim().toLowerCase().email().max(200),
      ownerPassword: z.string().max(128),
      justification,
    }).parse(req.body);
    const policy = passwordPolicyError(b.ownerPassword);
    if (policy) throw badRequest(policy);
    const plan = await c.db.query('SELECT 1 FROM plans WHERE code = $1', [b.planCode]);
    if (!plan.rowCount) throw badRequest('Plano inexistente.');
    const tenantId = randomUUID();
    try {
      await c.db.query(`INSERT INTO tenants (id, slug, name, plan_code, status) VALUES ($1,$2,$3,$4,'active')`, [tenantId, b.slug, b.name, b.planCode]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('Já existe uma clínica com este identificador.');
      throw e;
    }
    await c.db.query(
      `INSERT INTO users (id, tenant_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5,'owner')`,
      [randomUUID(), tenantId, b.ownerEmail, b.ownerName, await hashPassword(b.ownerPassword)]);
    await platformAudit(c, 'tenant.create', tenantId, b.justification, { slug: b.slug, plan: b.planCode });
    notify({ severity: 'info', component: 'clientes', title: 'Novo cliente cadastrado', detail: `Plano ${b.planCode}`, tenant: { id: tenantId, name: b.name } });
    return { id: tenantId };
  });

  masterRoute(app, 'PATCH', '/api/master/tenants/:id', async (c, req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      planCode: z.string().min(1).max(40).optional(),
      status: z.enum(['active', 'suspended', 'closed']).optional(),
      code: z.string().max(10).optional(),
      justification,
    }).parse(req.body);
    const cur = await c.db.query<{ status: string; plan_code: string; name: string }>('SELECT status, plan_code, name FROM tenants WHERE id = $1 FOR UPDATE', [id]);
    const tenant = cur.rows[0];
    if (!tenant) throw notFound('Clínica não encontrada.');
    if (tenant.status === 'closed') throw conflict('Clínica encerrada não pode ser alterada.');
    if (b.status && b.status !== tenant.status) {
      await requireFreshMfa(c, b.code); // ação crítica: reautenticação
      await c.db.query('UPDATE tenants SET status = $1 WHERE id = $2', [b.status, id]);
      await platformAudit(c, `tenant.status.${b.status}`, id, b.justification, { from: tenant.status });
      notify({ severity: 'info', component: 'clientes', title: `Cliente ${{ active: 'reativado', suspended: 'suspenso', closed: 'encerrado' }[b.status]}`, tenant: { id, name: tenant.name }, fingerprint: `cliente|${id}|${b.status}` });
    }
    if (b.planCode && b.planCode !== tenant.plan_code) {
      const plan = await c.db.query('SELECT 1 FROM plans WHERE code = $1', [b.planCode]);
      if (!plan.rowCount) throw badRequest('Plano inexistente.');
      await c.db.query('UPDATE tenants SET plan_code = $1 WHERE id = $2', [b.planCode, id]);
      await platformAudit(c, 'tenant.plan.change', id, b.justification, { from: tenant.plan_code, to: b.planCode });
      notify({ severity: 'info', component: 'clientes', title: 'Cliente trocou de plano', detail: `${tenant.plan_code} → ${b.planCode}`, tenant: { id, name: tenant.name }, fingerprint: `plano|${id}|${b.planCode}` });
    }
    return { ok: true };
  });

  masterRoute(app, 'POST', '/api/master/tenants/:id/reset-owner-mfa', async (c, req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ code: z.string().max(10), justification }).parse(req.body);
    await requireFreshMfa(c, b.code);
    // Só MFA e versão de sessão do proprietário mudam; o Master não lê nem altera dados clínicos.
    const r = await c.db.query(
      `UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_last_step = NULL, session_version = session_version + 1
        WHERE tenant_id = $1 AND role = 'owner'`, [id]);
    if (!r.rowCount) throw notFound('Proprietário não encontrado.');
    await platformAudit(c, 'tenant.owner_mfa_reset', id, b.justification);
    return { ok: true };
  });

  masterRoute(app, 'POST', '/api/master/tenants/:id/overrides', async (c, req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      capability: z.string().min(1).max(60),
      mode: z.enum(['grant', 'block', 'clear']),
      reason: justification,
    }).parse(req.body);
    const t = await c.db.query('SELECT 1 FROM tenants WHERE id = $1', [id]);
    if (!t.rowCount) throw notFound('Clínica não encontrada.');
    if (b.mode === 'clear') {
      await c.db.query('DELETE FROM tenant_entitlement_overrides WHERE tenant_id = $1 AND capability_code = $2', [id, b.capability]);
    } else {
      try {
        await c.db.query(
          `INSERT INTO tenant_entitlement_overrides (tenant_id, capability_code, mode, reason) VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id, capability_code) DO UPDATE SET mode = EXCLUDED.mode, reason = EXCLUDED.reason`,
          [id, b.capability, b.mode, b.reason]);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === '23514') throw conflict('Esta funcionalidade está globalmente indisponível nesta fase.');
        if (code === '23503') throw badRequest('Funcionalidade inexistente.');
        throw e;
      }
    }
    await platformAudit(c, `tenant.override.${b.mode}`, id, b.reason, { capability: b.capability });
    return { ok: true };
  });

  // ------------------------------------------------------------ Integrações (sem acesso ao conteúdo das mensagens)
  masterRoute(app, 'GET', '/api/master/integrations', async (c) => {
    const queue = await c.db.query('SELECT status, count(*)::int AS count FROM outbox_events GROUP BY status');
    const dead = await c.db.query(`SELECT o.tenant_id AS "tenantId", t.name, count(*)::int AS dead FROM outbox_events o JOIN tenants t ON t.id = o.tenant_id WHERE o.status = 'dead' GROUP BY o.tenant_id, t.name ORDER BY dead DESC LIMIT 50`);
    const receipts = await c.db.query('SELECT status, count(*)::int AS count FROM webhook_receipts GROUP BY status');
    const connections = await c.db.query('SELECT tenant_id AS "tenantId", kind, provider, mode FROM integration_connections');
    return { providers: integrationHealth(), queue: queue.rows, deadByTenant: dead.rows, receipts: receipts.rows, connections: connections.rows };
  });

  // ------------------------------------------------------------ Alertas (Telegram): estado e teste feito pelo próprio sistema
  masterRoute(app, 'GET', '/api/master/alerts', async () => {
    const n = getNotifier();
    return { transport: n?.transportName ?? 'desligado', live: n?.transportName === 'telegram', env: n?.envLabel ?? null, mutedUntil: n ? (await n.mutedUntil()) || null : null, recent: n?.recent.slice(-15).reverse() ?? [] };
  });
  masterRoute(app, 'POST', '/api/master/alerts/test', async (c, req) => {
    const b = z.object({ kind: z.enum(['simple', 'error']) }).parse(req.body);
    const n = getNotifier();
    if (!n) throw new HttpError(503, 'Alertas não inicializados.', 'not_configured');
    const unique = `teste|${randomUUID()}`;
    let result: string;
    if (b.kind === 'simple') {
      result = await n.notify({ severity: 'info', component: 'sistema', title: 'Teste de alerta feito pelo Painel Master', detail: `Pedido por ${c.operator.name}. O canal funciona.`, where: 'Painel Master → Integrações → Alertas', fingerprint: unique });
    } else {
      // Erro de verdade, lançado e capturado aqui, para mostrar exatamente como um problema real é descrito (arquivo:linha, rota, código).
      let caught: unknown;
      try { simulatedFailure(); } catch (e) { caught = e; }
      result = await n.notify({ severity: 'critical', component: 'api', title: 'ERRO SIMULADO (teste, nada quebrou)', detail: 'Assim aparece um erro real: componente, clínica, rota, local no código e código para buscar nos logs.', where: locateError(caught), ref: req.id, route: `${req.method} ${req.routeOptions.url}`, tenant: { id: '00000000-0000-0000-0000-000000000000', name: 'Clínica de exemplo' }, fingerprint: unique });
    }
    return { result, transport: n.transportName };
  });

  masterRoute(app, 'POST', '/api/master/tenants/:id/integrations', async (c, req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ kind: z.enum(['whatsapp', 'email', 'sms']), mode: z.enum(['disabled', 'sandbox', 'live']), justification }).parse(req.body);
    const t = await c.db.query('SELECT 1 FROM tenants WHERE id = $1', [id]);
    if (!t.rowCount) throw notFound('Clínica não encontrada.');
    if (b.mode === 'live' && !LIVE_PROVIDERS[b.kind].configured()) throw conflict('O provedor deste canal ainda não está configurado no servidor (credenciais ausentes).');
    await c.db.query(
      `INSERT INTO integration_connections (tenant_id, kind, provider, mode) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, kind) DO UPDATE SET mode = EXCLUDED.mode, provider = EXCLUDED.provider, updated_at = now()`,
      [id, b.kind, LIVE_PROVIDERS[b.kind].provider, b.mode]);
    await platformAudit(c, 'tenant.integration.set', id, b.justification, { kind: b.kind, mode: b.mode });
    return { ok: true };
  });

  masterRoute(app, 'POST', '/api/master/integrations/requeue', async (c, req) => {
    const b = z.object({ tenantId: z.string().uuid(), code: z.string().max(10), justification }).parse(req.body);
    await requireFreshMfa(c, b.code);
    // Só recoloca na fila o que está morto; o Master não lê nem altera o conteúdo das mensagens.
    const o = await c.db.query(`UPDATE outbox_events SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE tenant_id = $1 AND status = 'dead'`, [b.tenantId]);
    const r = await c.db.query(`UPDATE webhook_receipts SET status = 'received', attempts = 0 WHERE status = 'dead'`);
    await platformAudit(c, 'integrations.requeue_dead', b.tenantId, b.justification, { messages: o.rowCount, receipts: r.rowCount });
    return { messages: o.rowCount ?? 0, receipts: r.rowCount ?? 0 };
  });

  masterRoute(app, 'GET', '/api/master/audit', async (c) => {
    const r = await c.db.query(
      `SELECT id, occurred_at AS "occurredAt", operator_id AS operator, action, tenant_id AS "tenantId", justification
         FROM platform_audit_events ORDER BY occurred_at DESC LIMIT 100`);
    return { events: r.rows };
  });
}

function simulatedFailure(): never { throw new Error('falha simulada para teste de alerta'); }
