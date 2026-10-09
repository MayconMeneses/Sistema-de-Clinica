import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clinicBillingStatus, currentMonthStart, dueState, effectivePrice, evaluateBilling, generateInvoices, todayBr } from '../../modules/billing/billing.js';
import { audit, clinicRoute, masterRoute } from '../context.js';
import { badRequest, conflict, notFound } from '../http.js';
import { usageOf } from '../limits.js';
import { justification, platformAudit, requireFreshMfa } from './master.js';
import { notify } from '../../ops/alerts.js';

const idParam = z.object({ id: z.string().uuid() });
const code = z.string().max(10).default('');
const optInt = (max: number) => z.number().int().min(1).max(max).nullable();

export function billingRoutes(app: FastifyInstance) {
  // ============================================================ CLÍNICA (só o proprietário)
  clinicRoute(app, 'GET', '/api/billing', { perm: 'billing.read' }, async (ctx) => {
    const plan = await ctx.tx.query(
      `SELECT p.code, p.name, p.price_cents AS "priceCents", b.price_override_cents AS "overrideCents", COALESCE(b.due_day, 10) AS "dueDay"
         FROM tenants t JOIN plans p ON p.code = t.plan_code LEFT JOIN tenant_billing b ON b.tenant_id = t.id`);
    const inv = await ctx.tx.query(
      `SELECT id, period::text AS period, amount_cents AS "amountCents", due_date::text AS "dueDate", status, paid_at AS "paidAt", paid_method AS "paidMethod"
         FROM platform_invoices ORDER BY period DESC LIMIT 24`);
    const p = plan.rows[0]!;
    return { plan: { ...p, priceCents: effectivePrice(p.priceCents, p.overrideCents) }, status: await clinicBillingStatus(ctx.tx), ...(await usageOf(ctx.tx)), invoices: inv.rows };
  });

  // Acesso temporário do suporte: a clínica decide, por prazo curto, e vê tudo o que o suporte abriu.
  clinicRoute(app, 'GET', '/api/support-grants', { perm: 'support.manage' }, async (ctx) => {
    const g = await ctx.tx.query(
      `SELECT g.id, g.reason, g.created_at AS "createdAt", g.expires_at AS "expiresAt", g.revoked_at AS "revokedAt",
              (g.revoked_at IS NULL AND g.expires_at > now()) AS active, u.name AS "grantedByName"
         FROM support_grants g JOIN users u ON u.tenant_id = g.tenant_id AND u.id = g.granted_by ORDER BY g.created_at DESC LIMIT 20`);
    const log = await ctx.tx.query(`SELECT id, operator_id AS operator, resource, occurred_at AS "occurredAt" FROM support_access_log ORDER BY occurred_at DESC LIMIT 50`);
    return { grants: g.rows, accessLog: log.rows };
  });

  clinicRoute(app, 'POST', '/api/support-grants', { perm: 'support.manage' }, async (ctx) => {
    const b = z.object({ hours: z.number().int().min(1).max(24), reason: z.string().trim().min(5, 'Conte o motivo (mín. 5 caracteres).').max(200) }).parse(ctx.req.body);
    const act = await ctx.tx.query(`SELECT 1 FROM support_grants WHERE revoked_at IS NULL AND expires_at > now()`);
    if (act.rowCount) throw conflict('Já existe um acesso do suporte liberado. Revogue-o antes de liberar outro.');
    const r = await ctx.tx.query<{ id: string; expires_at: Date }>(
      `INSERT INTO support_grants (tenant_id, granted_by, reason, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4)) RETURNING id, expires_at`,
      [ctx.tenantId, ctx.user.id, b.reason, b.hours]);
    await audit(ctx, 'support.granted', 'support_grant', r.rows[0]!.id, { hours: b.hours });
    return { id: r.rows[0]!.id, expiresAt: r.rows[0]!.expires_at };
  });

  clinicRoute(app, 'POST', '/api/support-grants/:id/revoke', { perm: 'support.manage' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query(`UPDATE support_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`, [id]);
    if (!r.rowCount) throw notFound('Acesso não encontrado ou já encerrado.');
    await audit(ctx, 'support.revoked', 'support_grant', id);
    return { ok: true };
  });

  // ============================================================ PLATAFORMA
  masterRoute(app, 'GET', '/api/master/billing', async (c) => {
    const today = todayBr();
    const plans = await c.db.query(`SELECT code, name, price_cents AS "priceCents", max_users AS "maxUsers", max_patients AS "maxPatients", max_storage_mb AS "maxStorageMb" FROM plans ORDER BY sort_order`);
    const t = await c.db.query(
      `SELECT t.id, t.slug, t.name, t.status, t.plan_code AS "planCode", p.price_cents AS "planPriceCents", b.price_override_cents AS "overrideCents",
              COALESCE(b.due_day, 10) AS "dueDay", COALESCE(b.grace_days, 7) AS "graceDays", COALESCE(b.suspended_by_billing, false) AS "suspendedByBilling",
              COALESCE((SELECT array_agg(i.due_date::text) FROM platform_invoices i WHERE i.tenant_id = t.id AND i.status = 'open'), '{}') AS dues
         FROM tenants t JOIN plans p ON p.code = t.plan_code LEFT JOIN tenant_billing b ON b.tenant_id = t.id WHERE t.status <> 'closed' ORDER BY t.name`);
    const inv = await c.db.query(
      `SELECT i.id, i.tenant_id AS "tenantId", t.name AS "tenantName", i.period::text AS period, i.amount_cents AS "amountCents", i.due_date::text AS "dueDate",
              i.status, i.paid_at AS "paidAt", i.paid_method AS "paidMethod", i.void_reason AS "voidReason"
         FROM platform_invoices i JOIN tenants t ON t.id = i.tenant_id ORDER BY i.period DESC, t.name LIMIT 150`);
    return {
      today, plans: plans.rows,
      tenants: t.rows.map(({ dues, planPriceCents, ...x }) => ({ ...x, priceCents: effectivePrice(planPriceCents, x.overrideCents), openInvoices: dues.length, ...dueState(today, dues, x.graceDays) })),
      invoices: inv.rows,
    };
  });

  masterRoute(app, 'PATCH', '/api/master/plans/:code', async (c, req) => {
    const { code: planCode } = z.object({ code: z.string().min(1).max(40) }).parse(req.params);
    const b = z.object({
      priceCents: z.number().int().min(0).max(100_000_000).nullable(), maxUsers: optInt(100_000), maxPatients: optInt(10_000_000), maxStorageMb: optInt(10_000_000),
      code, justification,
    }).parse(req.body);
    await requireFreshMfa(c, b.code);
    const r = await c.db.query('UPDATE plans SET price_cents = $2, max_users = $3, max_patients = $4, max_storage_mb = $5 WHERE code = $1', [planCode, b.priceCents, b.maxUsers, b.maxPatients, b.maxStorageMb]);
    if (!r.rowCount) throw notFound('Plano não encontrado.');
    await platformAudit(c, 'plan.pricing_change', null, b.justification, { plan: planCode, priceCents: b.priceCents, maxUsers: b.maxUsers, maxPatients: b.maxPatients, maxStorageMb: b.maxStorageMb });
    return { ok: true };
  });

  masterRoute(app, 'PATCH', '/api/master/tenants/:id/billing', async (c, req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ overrideCents: z.number().int().min(0).max(100_000_000).nullable(), dueDay: z.number().int().min(1).max(28), graceDays: z.number().int().min(0).max(60), justification }).parse(req.body);
    if (!(await c.db.query('SELECT 1 FROM tenants WHERE id = $1', [id])).rowCount) throw notFound('Clínica não encontrada.');
    await c.db.query(
      `INSERT INTO tenant_billing (tenant_id, price_override_cents, due_day, grace_days) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id) DO UPDATE SET price_override_cents = $2, due_day = $3, grace_days = $4, updated_at = now()`, [id, b.overrideCents, b.dueDay, b.graceDays]);
    await platformAudit(c, 'tenant.billing_change', id, b.justification, { overrideCents: b.overrideCents, dueDay: b.dueDay, graceDays: b.graceDays });
    return { ok: true };
  });

  masterRoute(app, 'POST', '/api/master/billing/generate', async (c, req) => {
    const b = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional(), justification }).parse(req.body);
    const period = b.period ? `${b.period}-01` : currentMonthStart();
    if (Number.isNaN(Date.parse(`${period}T00:00:00Z`)) || Number(period.slice(5, 7)) > 12 || Number(period.slice(5, 7)) < 1) throw badRequest('Mês inválido.');
    const r = await generateInvoices(c.db, period);
    await platformAudit(c, 'billing.generate', null, b.justification, { period, ...r });
    return { period, ...r };
  });

  masterRoute(app, 'POST', '/api/master/billing/run', async (c, req) => {
    const b = z.object({ code, justification }).parse(req.body);
    await requireFreshMfa(c, b.code);   // pode suspender clínicas
    const changes = await evaluateBilling(c.db, todayBr());
    for (const ch of changes) {
      await platformAudit(c, `tenant.billing_${ch.action}`, ch.tenantId, b.justification, { daysOverdue: ch.daysOverdue });
      notify({ severity: ch.action === 'suspended' ? 'warning' : 'info', component: 'clientes', title: ch.action === 'suspended' ? 'Cliente suspenso por inadimplência' : 'Cliente reativado após pagamento', detail: `${ch.daysOverdue} dia(s) de atraso`, tenant: { id: ch.tenantId, name: ch.name }, fingerprint: `cobranca|${ch.tenantId}|${ch.action}` });
    }
    return { changes: changes.map((x) => ({ slug: x.slug, name: x.name, action: x.action, daysOverdue: x.daysOverdue })) };
  });

  masterRoute(app, 'POST', '/api/master/invoices/:id/pay', async (c, req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ method: z.enum(['pix', 'boleto', 'card', 'transfer', 'other']), reference: z.string().trim().max(120).optional(), justification }).parse(req.body);
    const cur = await c.db.query<{ status: string; tenant_id: string }>('SELECT status, tenant_id FROM platform_invoices WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Fatura não encontrada.');
    if (cur.rows[0].status !== 'open') throw conflict('Esta fatura já está encerrada.');
    await c.db.query(`UPDATE platform_invoices SET status = 'paid', paid_at = now(), paid_method = $2, paid_reference = $3 WHERE id = $1`, [id, b.method, b.reference || null]);
    await platformAudit(c, 'invoice.paid', cur.rows[0].tenant_id, b.justification, { invoice: id, method: b.method });
    // quitou? reativa na hora quem estava suspenso por cobrança
    await evaluateBilling(c.db, todayBr());
    return { ok: true };
  });

  masterRoute(app, 'POST', '/api/master/invoices/:id/void', async (c, req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ reason: z.string().trim().min(3).max(200), justification }).parse(req.body);
    const cur = await c.db.query<{ status: string; tenant_id: string }>('SELECT status, tenant_id FROM platform_invoices WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Fatura não encontrada.');
    if (cur.rows[0].status !== 'open') throw conflict('Esta fatura já está encerrada.');
    await c.db.query(`UPDATE platform_invoices SET status = 'void', void_reason = $2 WHERE id = $1`, [id, b.reason]);
    await platformAudit(c, 'invoice.void', cur.rows[0].tenant_id, b.justification, { invoice: id });
    await evaluateBilling(c.db, todayBr());
    return { ok: true };
  });

  // ---- suporte: lista de concessões ativas e abertura (MFA + justificativa) dos dados de configuração
  masterRoute(app, 'GET', '/api/master/support', async (c) => {
    const r = await c.db.query(
      `SELECT g.id, g.tenant_id AS "tenantId", t.name AS "tenantName", t.slug, g.reason, g.created_at AS "createdAt", g.expires_at AS "expiresAt"
         FROM support_grants g JOIN tenants t ON t.id = g.tenant_id WHERE g.revoked_at IS NULL AND g.expires_at > now() ORDER BY g.expires_at`);
    return { grants: r.rows };
  });

  masterRoute(app, 'POST', '/api/master/tenants/:id/support/open', async (c, req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ code, justification }).parse(req.body);
    await requireFreshMfa(c, b.code);
    const g = await c.db.query<{ id: string }>(`SELECT id FROM support_grants WHERE tenant_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [id]);
    if (!g.rows[0]) throw conflict('A clínica não liberou acesso ao suporte (ou o prazo acabou).');
    await c.db.query(`INSERT INTO support_access_log (tenant_id, grant_id, operator_id, resource) VALUES ($1,$2,$3,'config')`, [id, g.rows[0].id, c.operator.email]);
    await platformAudit(c, 'support.open', id, b.justification, { grant: g.rows[0].id });
    // Só configuração e equipe: sem paciente, prontuário, financeiro ou mensagens (o banco também não permite).
    const users = await c.db.query(`SELECT name, email, role, status, totp_enabled AS "mfaEnabled" FROM users WHERE tenant_id = $1 ORDER BY name`, [id]);
    const units = await c.db.query(`SELECT name FROM units WHERE tenant_id = $1 ORDER BY name`, [id]);
    const audit = await c.db.query(`SELECT occurred_at AS "occurredAt", action, entity_type AS "entityType" FROM audit_events WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 50`, [id]);
    const t = await c.db.query(`SELECT name, slug, status, plan_code AS "planCode" FROM tenants WHERE id = $1`, [id]);
    return { tenant: t.rows[0], users: users.rows, units: units.rows, audit: audit.rows };
  });
}
