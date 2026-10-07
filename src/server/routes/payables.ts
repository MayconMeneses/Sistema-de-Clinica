import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute } from '../context.js';
import { badRequest, conflict, mapDbError, notFound } from '../http.js';

const ADV = { cap: 'finance.advanced' } as const;
const idParam = z.object({ id: z.string().uuid() });
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (use AAAA-MM-DD).')
  .refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, 'Data inexistente.');
const money = z.number().int().min(1).max(1_000_000_000);
const TODAY = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
export const PAY_METHODS = ['cash', 'pix', 'transfer', 'card', 'boleto', 'other'] as const;

const COLS = `p.id, p.group_id AS "groupId", p.installment, p.installments, p.description, p.supplier, p.category, p.amount_cents::text AS "amountCents",
  to_char(p.due_on, 'YYYY-MM-DD') AS "dueOn", p.status, to_char(p.paid_on, 'YYYY-MM-DD') AS "paidOn", p.paid_method AS "paidMethod",
  p.paid_cents::text AS "paidCents", p.cancel_reason AS "cancelReason", (p.status = 'open' AND p.due_on < ${TODAY}) AS overdue,
  (p.due_on - ${TODAY})::int AS "daysToDue", up.name AS "paidByName"`;
const FROM = `FROM payables p LEFT JOIN users up ON up.tenant_id = p.tenant_id AND up.id = p.paid_by`;

/** Soma `n` meses a uma data AAAA-MM-DD, mantendo o dia (ou o último dia do mês, se não existir). */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = (m - 1) + n;
  const ty = y + Math.floor(total / 12), tm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export function payableRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/payables', { ...ADV, perm: 'payables.read' }, async (ctx) => {
    const q = z.object({ status: z.enum(['open', 'paid', 'canceled', 'all']).default('open'), from: ymd.optional(), to: ymd.optional(), q: z.string().trim().max(80).optional() }).parse(ctx.req.query);
    const r = await ctx.tx.query(
      `SELECT ${COLS} ${FROM}
        WHERE ($1::text = 'all' OR p.status = $1) AND ($2::date IS NULL OR p.due_on >= $2) AND ($3::date IS NULL OR p.due_on <= $3)
          AND ($4::text IS NULL OR p.description ILIKE $4 OR p.supplier ILIKE $4)
        ORDER BY (p.status = 'open') DESC, p.due_on, p.created_at LIMIT 300`,
      [q.status, q.from ?? null, q.to ?? null, q.q ? `%${q.q.replace(/[%_]/g, '')}%` : null]);
    const s = await ctx.tx.query<{ open: string; overdue: string; overdue_n: number; soon: string; paid_month: string }>(
      `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status='open'),0)::text AS open,
              COALESCE(SUM(amount_cents) FILTER (WHERE status='open' AND due_on < ${TODAY}),0)::text AS overdue,
              COUNT(*) FILTER (WHERE status='open' AND due_on < ${TODAY})::int AS overdue_n,
              COALESCE(SUM(amount_cents) FILTER (WHERE status='open' AND due_on BETWEEN ${TODAY} AND ${TODAY} + 7),0)::text AS soon,
              COALESCE(SUM(paid_cents) FILTER (WHERE status='paid' AND date_trunc('month', paid_on) = date_trunc('month', ${TODAY})),0)::text AS paid_month
         FROM payables`);
    const x = s.rows[0]!;
    return { payables: r.rows, summary: { openCents: x.open, overdueCents: x.overdue, overdueCount: x.overdue_n, dueSoonCents: x.soon, paidThisMonthCents: x.paid_month } };
  });

  // Cria uma conta ou, com `installments` > 1, parcelas mensais (o valor informado é de cada parcela).
  clinicRoute(app, 'POST', '/api/payables', { ...ADV, perm: 'payables.write' }, async (ctx) => {
    const b = z.object({
      description: z.string().trim().min(2).max(160), supplier: z.string().trim().min(1).max(120).optional(), category: z.string().trim().min(1).max(60).optional(),
      amountCents: money, dueOn: ymd, installments: z.number().int().min(1).max(60).default(1),
    }).parse(ctx.req.body);
    const group = randomUUID();
    const ids: string[] = [];
    try {
      for (let i = 1; i <= b.installments; i++) {
        const r = await ctx.tx.query<{ id: string }>(
          `INSERT INTO payables (tenant_id, group_id, installment, installments, description, supplier, category, amount_cents, due_on, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [ctx.tenantId, group, i, b.installments, b.description, b.supplier ?? null, b.category ?? null, b.amountCents, addMonths(b.dueOn, i - 1), ctx.user.id]);
        ids.push(r.rows[0]!.id);
      }
    } catch (e) { return mapDbError(e); }
    await audit(ctx, 'payable.create', 'payable', ids[0], { installments: b.installments, amountCents: b.amountCents });
    return { ids, groupId: group };
  });

  clinicRoute(app, 'PATCH', '/api/payables/:id', { ...ADV, perm: 'payables.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ description: z.string().trim().min(2).max(160).optional(), supplier: z.string().trim().max(120).optional(), category: z.string().trim().max(60).optional(), amountCents: money.optional(), dueOn: ymd.optional() }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ status: string }>('SELECT status FROM payables WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Conta não encontrada.');
    if (cur.rows[0].status !== 'open') throw conflict('Conta paga ou cancelada não pode ser alterada.');
    try {
      await ctx.tx.query(
        `UPDATE payables SET description = COALESCE($2, description), supplier = COALESCE(NULLIF($3, ''), supplier), category = COALESCE(NULLIF($4, ''), category),
                amount_cents = COALESCE($5, amount_cents), due_on = COALESCE($6::date, due_on) WHERE id = $1`,
        [id, b.description ?? null, b.supplier ?? null, b.category ?? null, b.amountCents ?? null, b.dueOn ?? null]);
    } catch (e) { return mapDbError(e); }
    await audit(ctx, 'payable.update', 'payable', id, { fields: Object.keys(b) });
    return { ok: true };
  });

  clinicRoute(app, 'POST', '/api/payables/:id/pay', { ...ADV, perm: 'payables.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ method: z.enum(PAY_METHODS), paidOn: ymd.optional(), paidCents: money.optional() }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ status: string; amount_cents: string; today: string }>(
      `SELECT status, amount_cents::text, to_char(${TODAY}, 'YYYY-MM-DD') AS today FROM payables WHERE id = $1 FOR UPDATE`, [id]);
    const p = cur.rows[0];
    if (!p) throw notFound('Conta não encontrada.');
    if (p.status === 'paid') throw conflict('Esta conta já foi paga.');
    if (p.status === 'canceled') throw conflict('Conta cancelada não pode ser paga.');
    const paidOn = b.paidOn ?? p.today;
    if (paidOn > p.today) throw badRequest('A data do pagamento não pode ser no futuro.');
    await ctx.tx.query(
      `UPDATE payables SET status = 'paid', paid_on = $2, paid_method = $3, paid_cents = $4, paid_by = $5, paid_at = now() WHERE id = $1`,
      [id, paidOn, b.method, b.paidCents ?? p.amount_cents, ctx.user.id]);
    await audit(ctx, 'payable.pay', 'payable', id, { method: b.method, paidCents: b.paidCents ?? p.amount_cents });
    return { ok: true };
  });

  clinicRoute(app, 'POST', '/api/payables/:id/cancel', { ...ADV, perm: 'payables.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ reason: z.string().trim().min(3).max(200) }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ status: string }>('SELECT status FROM payables WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Conta não encontrada.');
    if (cur.rows[0].status !== 'open') throw conflict(cur.rows[0].status === 'paid' ? 'Conta paga não pode ser cancelada.' : 'Esta conta já foi cancelada.');
    await ctx.tx.query(`UPDATE payables SET status = 'canceled', cancel_reason = $2, canceled_by = $3, canceled_at = now() WHERE id = $1`, [id, b.reason, ctx.user.id]);
    await audit(ctx, 'payable.cancel', 'payable', id);
    return { ok: true };
  });
}
