import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute, type ClinicCtx } from '../context.js';
import { badRequest, mapDbError, notFound } from '../http.js';

const FIN = { cap: 'finance.basic' } as const;
const idParam = z.object({ id: z.string().uuid() });

/** Saldo derivado dos movimentos (nunca mutável): cobranças − pagamentos + estornos. Valores em centavos (bigint). */
async function patientTotals(ctx: ClinicCtx, patientId: string) {
  const r = await ctx.tx.query<{ charged: string; paid: string; refunded: string }>(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE kind='charge'),0)::text AS charged,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind='payment'),0)::text AS paid,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind='refund'),0)::text AS refunded
       FROM financial_movements WHERE patient_id = $1`, [patientId]);
  const t = r.rows[0]!;
  const charged = BigInt(t.charged), paid = BigInt(t.paid), refunded = BigInt(t.refunded);
  return { charged, paid, refunded, balance: charged - paid + refunded, netPaid: paid - refunded };
}

export function financeRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/patients/:id/finance', { ...FIN, perm: 'finance.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const m = await ctx.tx.query(
      `SELECT id, kind, method, amount_cents::text AS "amountCents", note, created_at AS "createdAt", appointment_id AS "appointmentId"
         FROM financial_movements WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 200`, [id]);
    const t = await patientTotals(ctx, id);
    return { movements: m.rows, balanceCents: t.balance.toString(), chargedCents: t.charged.toString(), paidCents: t.netPaid.toString() };
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
    if (b.idempotencyKey) {
      const dup = await ctx.tx.query<{ id: string }>('SELECT id FROM financial_movements WHERE idempotency_key = $1', [b.idempotencyKey]);
      if (dup.rows[0]) return { id: dup.rows[0].id, duplicate: true };
    }
    if (b.kind === 'refund') {
      const t = await patientTotals(ctx, b.patientId);
      if (BigInt(b.amountCents) > t.netPaid) throw badRequest('O estorno excede o valor pago.');
    }
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO financial_movements (tenant_id, patient_id, kind, method, amount_cents, note, idempotency_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.tenantId, b.patientId, b.kind, b.method ?? null, b.amountCents, b.note ?? null, b.idempotencyKey ?? null, ctx.user.id]);
      await audit(ctx, `finance.${b.kind}`, 'movement', r.rows[0]!.id, { amountCents: b.amountCents });
      return { id: r.rows[0]!.id, duplicate: false };
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
         SELECT SUM(CASE kind WHEN 'charge' THEN amount_cents WHEN 'payment' THEN -amount_cents ELSE amount_cents END) AS bal
           FROM financial_movements GROUP BY patient_id) x`);
    return { receivedToday: today.rows, outstandingCents: open.rows[0]!.total };
  });
}
