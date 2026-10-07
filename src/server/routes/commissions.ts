import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute, type ClinicCtx } from '../context.js';
import { badRequest, conflict, mapDbError, notFound } from '../http.js';

const ADV = { cap: 'finance.advanced' } as const;
const idParam = z.object({ id: z.string().uuid() });
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (use AAAA-MM-DD).')
  .refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, 'Data inexistente.');
const TZ = "'America/Sao_Paulo'";
const TODAY = `(now() AT TIME ZONE ${TZ})::date`;

/**
 * Produção do período por profissional: cobranças (atendimento/procedimento concluído) atribuídas a ele, com o percentual
 * vigente na data de cada cobrança. Parâmetros: $1 = início, $2 = fim (inclusive), $3 = profissional (opcional).
 * A comissão é a soma, cobrança a cobrança, de floor(valor × percentual).
 */
const PRODUCTION = `
  WITH ch AS (
    SELECT m.id, m.amount_cents, m.patient_id, m.note, m.created_at, (m.created_at AT TIME ZONE ${TZ})::date AS d,
           COALESCE(m.professional_id, a.professional_id) AS pro
      FROM financial_movements m
      LEFT JOIN appointments a ON a.tenant_id = m.tenant_id AND a.id = m.appointment_id
     WHERE m.kind = 'charge' AND (m.created_at AT TIME ZONE ${TZ})::date BETWEEN $1::date AND $2::date
  ), calc AS (
    SELECT ch.*, COALESCE(r.percent_bp, 0) AS bp, (ch.amount_cents * COALESCE(r.percent_bp, 0)) / 10000 AS commission
      FROM ch
      LEFT JOIN LATERAL (SELECT percent_bp FROM commission_rules r WHERE r.professional_id = ch.pro AND r.effective_from <= ch.d
                          ORDER BY r.effective_from DESC, r.created_at DESC LIMIT 1) r ON true
     WHERE ch.pro IS NOT NULL AND ($3::uuid IS NULL OR ch.pro = $3)
  )`;

interface ProRow { professionalId: string; name: string; chargesCount: number; baseCents: string; commissionCents: string }

async function statement(ctx: ClinicCtx, from: string, to: string, professionalId?: string) {
  const r = await ctx.tx.query<ProRow>(
    `${PRODUCTION}
     SELECT u.id AS "professionalId", u.name, COUNT(calc.id)::int AS "chargesCount", COALESCE(SUM(calc.amount_cents),0)::text AS "baseCents",
            COALESCE(SUM(calc.commission),0)::text AS "commissionCents"
       FROM users u LEFT JOIN calc ON calc.pro = u.id
      WHERE u.role = 'professional' AND u.status = 'active' AND ($3::uuid IS NULL OR u.id = $3)
      GROUP BY u.id, u.name ORDER BY u.name`, [from, to, professionalId ?? null]);
  const unattributed = await ctx.tx.query<{ n: number; total: string }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(m.amount_cents),0)::text AS total
       FROM financial_movements m LEFT JOIN appointments a ON a.tenant_id = m.tenant_id AND a.id = m.appointment_id
      WHERE m.kind = 'charge' AND (m.created_at AT TIME ZONE ${TZ})::date BETWEEN $1::date AND $2::date AND COALESCE(m.professional_id, a.professional_id) IS NULL`, [from, to]);
  return { professionals: r.rows, unattributed: { count: unattributed.rows[0]!.n, totalCents: unattributed.rows[0]!.total } };
}

export function commissionRoutes(app: FastifyInstance) {
  // Regras vigentes (hoje) de cada profissional ativo.
  clinicRoute(app, 'GET', '/api/commissions/rules', { ...ADV, perm: 'commissions.read' }, async (ctx) => {
    const r = await ctx.tx.query(
      `SELECT u.id AS "professionalId", u.name, COALESCE(cr.percent_bp, 0) AS "percentBp", to_char(cr.effective_from, 'YYYY-MM-DD') AS "effectiveFrom"
         FROM users u
         LEFT JOIN LATERAL (SELECT percent_bp, effective_from FROM commission_rules r WHERE r.professional_id = u.id AND r.effective_from <= ${TODAY}
                             ORDER BY r.effective_from DESC, r.created_at DESC LIMIT 1) cr ON true
        WHERE u.role = 'professional' AND u.status = 'active' ORDER BY u.name`);
    return { rules: r.rows };
  });

  // Nova regra = nova linha (histórico preservado). Vale a partir da data informada (padrão: hoje); não retroage sem data explícita.
  clinicRoute(app, 'POST', '/api/commissions/rules', { ...ADV, perm: 'commissions.write' }, async (ctx) => {
    const b = z.object({ professionalId: z.string().uuid(), percent: z.number().min(0).max(100), effectiveFrom: ymd.optional() }).parse(ctx.req.body);
    const bp = Math.round(b.percent * 100);
    if (Math.abs(b.percent * 100 - bp) > 1e-6) throw badRequest('Use no máximo 2 casas decimais no percentual.');
    const pro = await ctx.tx.query('SELECT 1 FROM users WHERE id = $1 AND role = \'professional\' AND status = \'active\'', [b.professionalId]);
    if (!pro.rowCount) throw notFound('Profissional não encontrado.');
    const r = await ctx.tx.query<{ id: string }>(
      `INSERT INTO commission_rules (tenant_id, professional_id, percent_bp, effective_from, created_by) VALUES ($1,$2,$3,COALESCE($4::date, ${TODAY}),$5) RETURNING id`,
      [ctx.tenantId, b.professionalId, bp, b.effectiveFrom ?? null, ctx.user.id]);
    await audit(ctx, 'commission.rule', 'user', b.professionalId, { percentBp: bp, effectiveFrom: b.effectiveFrom ?? 'hoje' });
    return { id: r.rows[0]!.id };
  });

  clinicRoute(app, 'GET', '/api/commissions/statement', { ...ADV, perm: 'commissions.read' }, async (ctx) => {
    const q = z.object({ from: ymd, to: ymd, professionalId: z.string().uuid().optional() }).parse(ctx.req.query);
    if (q.to < q.from) throw badRequest('O fim do período é anterior ao início.');
    const st = await statement(ctx, q.from, q.to, q.professionalId);
    const paid = await ctx.tx.query(
      `SELECT professional_id AS "professionalId", COUNT(*)::int AS n FROM commission_payouts
        WHERE voided_at IS NULL AND period_from <= $2::date AND period_to >= $1::date GROUP BY professional_id`, [q.from, q.to]);
    const overlap = new Map((paid.rows as { professionalId: string; n: number }[]).map((x) => [x.professionalId, x.n]));
    return { from: q.from, to: q.to, ...st, professionals: st.professionals.map((p) => ({ ...p, hasPayoutInPeriod: (overlap.get(p.professionalId) ?? 0) > 0 })) };
  });

  // Detalhe: cobranças que compõem a comissão de um profissional no período.
  clinicRoute(app, 'GET', '/api/commissions/statement/:id', { ...ADV, perm: 'commissions.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const q = z.object({ from: ymd, to: ymd }).parse(ctx.req.query);
    const r = await ctx.tx.query(
      `${PRODUCTION}
       SELECT calc.id, to_char(calc.d, 'YYYY-MM-DD') AS date, p.name AS "patientName", calc.note, calc.amount_cents::text AS "amountCents", calc.bp AS "percentBp", calc.commission::text AS "commissionCents"
         FROM calc JOIN patients p ON p.tenant_id = $4::uuid AND p.id = calc.patient_id
        ORDER BY calc.created_at LIMIT 500`, [q.from, q.to, id, ctx.tenantId]);
    return { charges: r.rows };
  });

  // Registra o repasse de um período. O valor é recalculado aqui; o cliente não informa valores.
  clinicRoute(app, 'POST', '/api/commissions/payouts', { ...ADV, perm: 'commissions.write' }, async (ctx) => {
    const b = z.object({
      professionalId: z.string().uuid(), from: ymd, to: ymd, method: z.enum(['cash', 'pix', 'transfer', 'other']),
      paidOn: ymd.optional(), note: z.string().trim().max(200).optional(),
    }).parse(ctx.req.body);
    if (b.to < b.from) throw badRequest('O fim do período é anterior ao início.');
    const today = (await ctx.tx.query<{ d: string }>(`SELECT to_char(${TODAY}, 'YYYY-MM-DD') AS d`)).rows[0]!.d;
    if (b.to > today) throw badRequest('Só é possível repassar períodos já encerrados.');
    if (b.paidOn && b.paidOn > today) throw badRequest('A data do pagamento não pode ser no futuro.');
    // Serializa repasses do mesmo profissional.
    const pro = await ctx.tx.query('SELECT 1 FROM users WHERE id = $1 AND role = \'professional\' FOR UPDATE', [b.professionalId]);
    if (!pro.rowCount) throw notFound('Profissional não encontrado.');
    const st = await statement(ctx, b.from, b.to, b.professionalId);
    const p = st.professionals[0];
    if (!p || p.chargesCount < 1 || BigInt(p.commissionCents) < 1n) throw badRequest('Não há comissão a repassar neste período para este profissional.');
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO commission_payouts (tenant_id, professional_id, period_from, period_to, base_cents, amount_cents, charges_count, method, note, paid_on, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::date, ${TODAY}),$11) RETURNING id`,
        [ctx.tenantId, b.professionalId, b.from, b.to, p.baseCents, p.commissionCents, p.chargesCount, b.method, b.note ?? null, b.paidOn ?? null, ctx.user.id]);
      await audit(ctx, 'commission.payout', 'user', b.professionalId, { from: b.from, to: b.to, amountCents: p.commissionCents });
      return { id: r.rows[0]!.id, amountCents: p.commissionCents, baseCents: p.baseCents, chargesCount: p.chargesCount };
    } catch (e) {
      if ((e as { code?: string }).code === '23P01') throw conflict('Já existe um repasse deste profissional que cobre parte deste período.');
      return mapDbError(e);
    }
  });

  clinicRoute(app, 'GET', '/api/commissions/payouts', { ...ADV, perm: 'commissions.read' }, async (ctx) => {
    const r = await ctx.tx.query(
      `SELECT o.id, o.professional_id AS "professionalId", u.name, to_char(o.period_from, 'YYYY-MM-DD') AS "from", to_char(o.period_to, 'YYYY-MM-DD') AS "to",
              o.base_cents::text AS "baseCents", o.amount_cents::text AS "amountCents", o.charges_count AS "chargesCount", o.method, o.note,
              to_char(o.paid_on, 'YYYY-MM-DD') AS "paidOn", (o.voided_at IS NOT NULL) AS voided, o.void_reason AS "voidReason", uc.name AS "createdByName"
         FROM commission_payouts o JOIN users u ON u.tenant_id = o.tenant_id AND u.id = o.professional_id
         LEFT JOIN users uc ON uc.tenant_id = o.tenant_id AND uc.id = o.created_by
        ORDER BY o.created_at DESC LIMIT 100`);
    return { payouts: r.rows };
  });

  clinicRoute(app, 'POST', '/api/commissions/payouts/:id/void', { ...ADV, perm: 'commissions.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ reason: z.string().trim().min(3).max(200) }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ voided_at: Date | null }>('SELECT voided_at FROM commission_payouts WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Repasse não encontrado.');
    if (cur.rows[0].voided_at) throw conflict('Este repasse já foi anulado.');
    await ctx.tx.query('UPDATE commission_payouts SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1', [id, ctx.user.id, b.reason]);
    await audit(ctx, 'commission.payout.void', 'commission_payout', id);
    return { ok: true };
  });
}
