import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute, type ClinicCtx } from '../context.js';
import { assertActive } from '../../modules/patients/family.js';
import { badRequest, conflict, forbidden, mapDbError, notFound } from '../http.js';
import { patientTotals } from './finance.js';

const ADV = { cap: 'finance.advanced' } as const;
const idParam = z.object({ id: z.string().uuid() });
const cents = z.number().int().min(0).max(100_000_000);

interface SessionRow {
  id: string; openedAt: string; openingCents: string; closedAt: string | null; expectedCents: string | null;
  countedCents: string | null; differenceCents: string | null; closeNote: string | null; openedByName: string | null; closedByName: string | null;
}
const SESSION_COLS = `s.id, s.opened_at AS "openedAt", s.opening_cents::text AS "openingCents", s.closed_at AS "closedAt",
  s.expected_cents::text AS "expectedCents", s.counted_cents::text AS "countedCents", s.difference_cents::text AS "differenceCents",
  s.close_note AS "closeNote", uo.name AS "openedByName", uc.name AS "closedByName"`;
const SESSION_JOIN = `FROM cash_sessions s
  LEFT JOIN users uo ON uo.tenant_id = s.tenant_id AND uo.id = s.opened_by
  LEFT JOIN users uc ON uc.tenant_id = s.tenant_id AND uc.id = s.closed_by`;

/** Movimentos do caixa: dinheiro esperado = abertura + dinheiro recebido − dinheiro devolvido + suprimentos − sangrias. */
async function sessionTotals(ctx: ClinicCtx, sessionId: string) {
  const r = await ctx.tx.query<{ method: string; received: string; refunded: string; n: string }>(
    `SELECT method,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind='payment'),0)::text AS received,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind='refund'),0)::text AS refunded,
            COUNT(*)::text AS n
       FROM financial_movements WHERE cash_session_id = $1 GROUP BY method`, [sessionId]);
  const byMethod = r.rows.map((x) => ({ method: x.method, receivedCents: x.received, refundedCents: x.refunded, count: Number(x.n) }));
  const cash = r.rows.find((x) => x.method === 'cash');
  const adj = await ctx.tx.query<{ withdrawals: string; supplies: string }>(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE kind='withdrawal'),0)::text AS withdrawals,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind='supply'),0)::text AS supplies
       FROM cash_adjustments WHERE cash_session_id = $1`, [sessionId]);
  const withdrawals = BigInt(adj.rows[0]?.withdrawals ?? '0');
  const supplies = BigInt(adj.rows[0]?.supplies ?? '0');
  const cashNet = (cash ? BigInt(cash.received) - BigInt(cash.refunded) : 0n) + supplies - withdrawals;
  return { byMethod, cashNet, withdrawals, supplies };
}

async function adjustmentsOf(ctx: ClinicCtx, sessionId: string) {
  const r = await ctx.tx.query(
    `SELECT a.id, a.kind, a.amount_cents::text AS "amountCents", a.reason, a.created_at AS "createdAt", u.name AS "createdByName"
       FROM cash_adjustments a LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.created_by
      WHERE a.cash_session_id = $1 ORDER BY a.created_at, a.id`, [sessionId]);
  return r.rows;
}

export function cashRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ Caixa
  clinicRoute(app, 'GET', '/api/cash/current', { ...ADV, perm: 'finance.read' }, async (ctx) => {
    const r = await ctx.tx.query<SessionRow>(`SELECT ${SESSION_COLS} ${SESSION_JOIN} WHERE s.closed_at IS NULL`);
    const s = r.rows[0];
    if (!s) return { session: null };
    const t = await sessionTotals(ctx, s.id);
    return {
      session: s, byMethod: t.byMethod, expectedCashCents: (BigInt(s.openingCents) + t.cashNet).toString(),
      withdrawalsCents: t.withdrawals.toString(), suppliesCents: t.supplies.toString(), adjustments: await adjustmentsOf(ctx, s.id),
    };
  });

  // Sangria (retirada) e suprimento (reforço de troco): imutáveis, só com o caixa aberto; sangria não passa do dinheiro esperado.
  clinicRoute(app, 'POST', '/api/cash/adjustments', { ...ADV, perm: 'cash.operate' }, async (ctx) => {
    const b = z.object({ kind: z.enum(['withdrawal', 'supply']), amountCents: z.number().int().min(1).max(100_000_000), reason: z.string().trim().min(3).max(200) }).parse(ctx.req.body);
    const open = await ctx.tx.query<{ id: string; opening: string }>('SELECT id, opening_cents::text AS opening FROM cash_sessions WHERE closed_at IS NULL FOR UPDATE');
    const s = open.rows[0];
    if (!s) throw conflict('Abra o caixa antes de lançar sangria ou suprimento.');
    if (b.kind === 'withdrawal') {
      const t = await sessionTotals(ctx, s.id);
      const expected = BigInt(s.opening) + t.cashNet;
      if (BigInt(b.amountCents) > expected) throw badRequest('A sangria é maior que o dinheiro esperado no caixa.');
    }
    try {
      const r = await ctx.tx.query<{ id: string }>(
        'INSERT INTO cash_adjustments (tenant_id, cash_session_id, kind, amount_cents, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [ctx.tenantId, s.id, b.kind, b.amountCents, b.reason, ctx.user.id]);
      await audit(ctx, `cash.${b.kind}`, 'cash_session', s.id, { amountCents: b.amountCents });
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'POST', '/api/cash/open', { ...ADV, perm: 'cash.operate' }, async (ctx) => {
    const b = z.object({ openingCents: cents }).parse(ctx.req.body);
    try {
      const r = await ctx.tx.query<{ id: string }>(
        'INSERT INTO cash_sessions (tenant_id, opened_by, opening_cents) VALUES ($1,$2,$3) RETURNING id', [ctx.tenantId, ctx.user.id, b.openingCents]);
      await audit(ctx, 'cash.open', 'cash_session', r.rows[0]!.id, { openingCents: b.openingCents });
      return { id: r.rows[0]!.id };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('Já existe um caixa aberto.');
      return mapDbError(e);
    }
  });

  clinicRoute(app, 'POST', '/api/cash/close', { ...ADV, perm: 'cash.operate' }, async (ctx) => {
    const b = z.object({ countedCents: cents, note: z.string().trim().max(300).optional() }).parse(ctx.req.body);
    // FOR UPDATE espera lançamentos em andamento e bloqueia novos: o esperado inclui tudo que entrou no caixa.
    const open = await ctx.tx.query<{ id: string; opening: string }>('SELECT id, opening_cents::text AS opening FROM cash_sessions WHERE closed_at IS NULL FOR UPDATE');
    const s = open.rows[0];
    if (!s) throw conflict('Não há caixa aberto.');
    const t = await sessionTotals(ctx, s.id);
    const expected = BigInt(s.opening) + t.cashNet;
    const diff = BigInt(b.countedCents) - expected;
    if (diff !== 0n && (b.note ?? '').length < 3) throw badRequest('Há diferença entre o contado e o esperado: explique no campo de observação.');
    await ctx.tx.query(
      `UPDATE cash_sessions SET closed_at = now(), closed_by = $2, counted_cents = $3, expected_cents = $4, difference_cents = $5, close_note = $6 WHERE id = $1`,
      [s.id, ctx.user.id, b.countedCents, expected.toString(), diff.toString(), b.note ?? null]);
    await audit(ctx, 'cash.close', 'cash_session', s.id, { expectedCents: expected.toString(), countedCents: b.countedCents, differenceCents: diff.toString() });
    return { id: s.id, expectedCents: expected.toString(), countedCents: String(b.countedCents), differenceCents: diff.toString(), byMethod: t.byMethod };
  });

  clinicRoute(app, 'GET', '/api/cash/sessions', { ...ADV, perm: 'finance.read' }, async (ctx) => {
    const r = await ctx.tx.query<SessionRow>(`SELECT ${SESSION_COLS} ${SESSION_JOIN} ORDER BY s.opened_at DESC LIMIT 30`);
    return { sessions: r.rows };
  });

  clinicRoute(app, 'GET', '/api/cash/sessions/:id', { ...ADV, perm: 'finance.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query<SessionRow>(`SELECT ${SESSION_COLS} ${SESSION_JOIN} WHERE s.id = $1`, [id]);
    if (!r.rows[0]) throw notFound('Caixa não encontrado.');
    const t = await sessionTotals(ctx, id);
    return { session: r.rows[0], byMethod: t.byMethod, withdrawalsCents: t.withdrawals.toString(), suppliesCents: t.supplies.toString(), adjustments: await adjustmentsOf(ctx, id) };
  });

  // ------------------------------------------------------------------ Descontos com aprovação
  clinicRoute(app, 'POST', '/api/finance/discount-requests', { ...ADV, perm: 'finance.write' }, async (ctx) => {
    const b = z.object({ patientId: z.string().uuid(), amountCents: z.number().int().min(1).max(100_000_000), reason: z.string().trim().min(3).max(300) }).parse(ctx.req.body);
    await assertActive(ctx.tx, b.patientId);
    const t = await patientTotals(ctx, b.patientId);
    if (BigInt(b.amountCents) > t.balance) throw badRequest('O desconto excede o valor em aberto do paciente.');
    try {
      const r = await ctx.tx.query<{ id: string }>(
        'INSERT INTO discount_requests (tenant_id, patient_id, amount_cents, reason, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [ctx.tenantId, b.patientId, b.amountCents, b.reason, ctx.user.id]);
      await audit(ctx, 'discount.request', 'discount_request', r.rows[0]!.id, { amountCents: b.amountCents });
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'GET', '/api/finance/discount-requests', { ...ADV, perm: 'finance.read' }, async (ctx) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }).parse(ctx.req.query);
    const r = await ctx.tx.query(
      `SELECT d.id, d.patient_id AS "patientId", p.name AS "patientName", d.amount_cents::text AS "amountCents", d.reason, d.status,
              d.requested_at AS "requestedAt", ur.name AS "requestedByName", d.requested_by AS "requestedById",
              d.decided_at AS "decidedAt", ud.name AS "decidedByName", d.decision_note AS "decisionNote"
         FROM discount_requests d
         JOIN patients p ON p.tenant_id = d.tenant_id AND p.id = d.patient_id
         LEFT JOIN users ur ON ur.tenant_id = d.tenant_id AND ur.id = d.requested_by
         LEFT JOIN users ud ON ud.tenant_id = d.tenant_id AND ud.id = d.decided_by
        WHERE ($1::text IS NULL OR d.status = $1)
        ORDER BY (d.status = 'pending') DESC, d.requested_at DESC LIMIT 100`, [q.status ?? null]);
    return { requests: r.rows };
  });

  clinicRoute(app, 'POST', '/api/finance/discount-requests/:id/decide', { ...ADV, perm: 'finance.approve' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(300).optional() }).parse(ctx.req.body);
    const r = await ctx.tx.query<{ patient_id: string; amount_cents: string; requested_by: string; status: string }>(
      'SELECT patient_id, amount_cents::text, requested_by, status FROM discount_requests WHERE id = $1 FOR UPDATE', [id]);
    const d = r.rows[0];
    if (!d) throw notFound('Pedido não encontrado.');
    if (d.status !== 'pending') throw conflict('Este pedido já foi decidido.');
    // Segregação de funções: quem pediu não aprova o próprio desconto (exceção: o proprietário, em clínica pequena; fica no registro).
    if (d.requested_by === ctx.user.id && ctx.user.role !== 'owner') throw forbidden('Outra pessoa precisa aprovar o desconto que você pediu.');
    if (b.decision === 'reject' && !b.note) throw badRequest('Informe o motivo da recusa.');

    let movementId: string | null = null;
    if (b.decision === 'approve') {
      // Serializa com os demais movimentos do paciente e revalida o saldo no momento da aprovação.
      await ctx.tx.query('SELECT 1 FROM patients WHERE id = $1 FOR UPDATE', [d.patient_id]);
      const t = await patientTotals(ctx, d.patient_id);
      if (BigInt(d.amount_cents) > t.balance) throw conflict('O saldo em aberto mudou e agora é menor que o desconto pedido.');
      try {
        const m = await ctx.tx.query<{ id: string }>(
          `INSERT INTO financial_movements (tenant_id, patient_id, kind, amount_cents, note, idempotency_key, created_by, discount_request_id)
           VALUES ($1,$2,'discount',$3,$4,$5,$6,$7) RETURNING id`,
          [ctx.tenantId, d.patient_id, d.amount_cents, `Desconto aprovado${b.note ? `: ${b.note}` : ''}`, `discount:${id}`, ctx.user.id, id]);
        movementId = m.rows[0]!.id;
      } catch (e) { return mapDbError(e); }
    }
    await ctx.tx.query(
      `UPDATE discount_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
      [id, b.decision === 'approve' ? 'approved' : 'rejected', ctx.user.id, b.note ?? null]);
    await audit(ctx, `discount.${b.decision}`, 'discount_request', id, { amountCents: d.amount_cents, selfApproved: d.requested_by === ctx.user.id });
    return { id, status: b.decision === 'approve' ? 'approved' : 'rejected', movementId };
  });
}
