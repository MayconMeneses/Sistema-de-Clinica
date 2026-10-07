import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute, type ClinicCtx } from '../context.js';
import { assertActive, family } from '../../modules/patients/family.js';
import { nextReceiptNumber } from '../../modules/finance/receipt.js';
import { badRequest, conflict, mapDbError, notFound } from '../http.js';

const FIN = { cap: 'finance.basic' } as const;
const ADV = 'finance.advanced';
const idParam = z.object({ id: z.string().uuid() });

/** Saldo derivado dos movimentos (nunca mutável): cobranças − pagamentos + estornos. Valores em centavos (bigint). */
async function patientTotals(ctx: ClinicCtx, patientId: string) {
  const r = await ctx.tx.query<{ charged: string; paid: string; refunded: string; discounted: string }>(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE kind='charge'),0)::text AS charged,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind='payment'),0)::text AS paid,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind='refund'),0)::text AS refunded,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind='discount'),0)::text AS discounted
       FROM financial_movements WHERE patient_id = ANY($1::uuid[])`, [await family(ctx.tx, patientId)]);
  const t = r.rows[0]!;
  const charged = BigInt(t.charged), paid = BigInt(t.paid), refunded = BigInt(t.refunded), discounted = BigInt(t.discounted);
  return { charged, paid, refunded, discounted, balance: charged - paid - discounted + refunded, netPaid: paid - refunded };
}

export { patientTotals };

export function financeRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/patients/:id/finance', { ...FIN, perm: 'finance.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const m = await ctx.tx.query(
      `SELECT id, kind, method, amount_cents::text AS "amountCents", note, created_at AS "createdAt", appointment_id AS "appointmentId", receipt_number::int AS "receiptNumber"
         FROM financial_movements WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at DESC LIMIT 200`, [await family(ctx.tx, id)]);
    const t = await patientTotals(ctx, id);
    return { movements: m.rows, balanceCents: t.balance.toString(), chargedCents: t.charged.toString(), paidCents: t.netPaid.toString(), discountedCents: t.discounted.toString() };
  });

  clinicRoute(app, 'POST', '/api/finance/movements', { ...FIN, perm: 'finance.write' }, async (ctx) => {
    const b = z.object({
      patientId: z.string().uuid(),
      kind: z.enum(['charge', 'payment', 'refund']),
      method: z.enum(['pix', 'card', 'cash']).optional(),
      amountCents: z.number().int().min(1).max(100_000_000),
      note: z.string().trim().max(300).optional(),
      idempotencyKey: z.string().trim().min(8).max(100).optional(),
    }).parse(ctx.req.body);
    if (b.kind === 'charge' && b.method) throw badRequest('Cobrança não tem forma de pagamento.');
    if (b.kind !== 'charge' && !b.method) throw badRequest('Informe a forma de pagamento.');

    // Serializa movimentos do mesmo paciente: evita estorno duplo concorrente.
    const lock = await ctx.tx.query('SELECT 1 FROM patients WHERE id = $1 FOR UPDATE', [b.patientId]);
    if (!lock.rowCount) throw notFound('Paciente não encontrado.');
    await assertActive(ctx.tx, b.patientId);
    if (b.idempotencyKey) {
      const dup = await ctx.tx.query<{ id: string }>('SELECT id FROM financial_movements WHERE idempotency_key = $1', [b.idempotencyKey]);
      if (dup.rows[0]) return { id: dup.rows[0].id, duplicate: true };
    }
    if (b.kind === 'refund') {
      const t = await patientTotals(ctx, b.patientId);
      if (BigInt(b.amountCents) > t.netPaid) throw badRequest('O estorno excede o valor pago.');
    }
    // Com o financeiro avançado, dinheiro só entra/sai com o caixa aberto; Pix/cartão ficam ligados ao caixa se houver um aberto.
    let cashSessionId: string | null = null;
    if (b.kind !== 'charge' && ctx.entitlements.has(ADV)) {
      const open = await ctx.tx.query<{ id: string }>('SELECT id FROM cash_sessions WHERE closed_at IS NULL FOR SHARE');
      cashSessionId = open.rows[0]?.id ?? null;
      if (!cashSessionId && b.method === 'cash') throw conflict('Abra o caixa antes de registrar dinheiro.');
    }
    try {
      let receipt: number | null = null;
      if (b.kind === 'payment') {
        receipt = await nextReceiptNumber(ctx.tx, ctx.tenantId);
      }
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO financial_movements (tenant_id, patient_id, kind, method, amount_cents, note, idempotency_key, created_by, cash_session_id, receipt_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [ctx.tenantId, b.patientId, b.kind, b.method ?? null, b.amountCents, b.note ?? null, b.idempotencyKey ?? null, ctx.user.id, cashSessionId, receipt]);
      await audit(ctx, `finance.${b.kind}`, 'movement', r.rows[0]!.id, { amountCents: b.amountCents, receiptNumber: receipt });
      return { id: r.rows[0]!.id, duplicate: false, receiptNumber: receipt };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'GET', '/api/finance/summary', { ...FIN, perm: 'finance.read' }, async (ctx) => {
    const today = await ctx.tx.query<{ method: string; total: string }>(
      `SELECT method, SUM(CASE kind WHEN 'payment' THEN amount_cents ELSE -amount_cents END)::text AS total
         FROM financial_movements
        WHERE kind IN ('payment','refund')
          AND created_at >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
        GROUP BY method`);
    const open = await ctx.tx.query<{ total: string }>(
      `SELECT COALESCE(SUM(GREATEST(bal,0)),0)::text AS total FROM (
         SELECT SUM(CASE kind WHEN 'charge' THEN amount_cents WHEN 'payment' THEN -amount_cents WHEN 'discount' THEN -amount_cents ELSE amount_cents END) AS bal
           FROM financial_movements GROUP BY patient_id) x`);
    return { receivedToday: today.rows, outstandingCents: open.rows[0]!.total };
  });

  /** Recibo de um pagamento (comprovante simples; não é documento fiscal). */
  clinicRoute(app, 'GET', '/api/finance/movements/:id/receipt', { ...FIN, perm: 'finance.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query(
      `SELECT m.receipt_number::int AS "number", m.amount_cents::text AS "amountCents", m.method, m.created_at AS "paidAt", m.note,
              p.name AS "patientName", u.name AS "receivedBy"
         FROM financial_movements m
         JOIN patients p ON p.tenant_id = m.tenant_id AND p.id = m.patient_id
         LEFT JOIN users u ON u.tenant_id = m.tenant_id AND u.id = m.created_by
        WHERE m.id = $1 AND m.kind = 'payment'`, [id]);
    if (!r.rows[0]) throw notFound('Recibo não encontrado.');
    return { ...r.rows[0], clinicName: ctx.tenantName, fiscal: false };
  });
}
