import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute, type ClinicCtx } from '../context.js';
import { assertActive, family } from '../../modules/patients/family.js';
import { badRequest, conflict, mapDbError, notFound } from '../http.js';

const CAP = { cap: 'dental.odontogram' } as const;
const idParam = z.object({ id: z.string().uuid() });
const TOOTH = z.string().regex(/^(1[1-8]|2[1-8]|3[1-8]|4[1-8]|5[1-5]|6[1-5]|7[1-5]|8[1-5])$/, 'Dente inválido (numeração FDI).');
const item = z.object({
  tooth: TOOTH.nullish().transform((v) => v ?? null),
  procedure: z.string().trim().min(2).max(160),
  priceCents: z.number().int().min(0).max(100_000_000),
});
const items = z.array(item).min(1, 'Inclua ao menos um procedimento.').max(40);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const TODAY_SP = "(now() AT TIME ZONE 'America/Sao_Paulo')::date";

interface QuoteRow {
  id: string; groupId: string; version: number; status: string; notes: string | null; validUntil: string | null; createdAt: string;
  presentedAt: string | null; decidedAt: string | null; acceptedByName: string | null; acceptedByRole: string | null; decisionNote: string | null;
  createdByName: string | null; decidedByName: string | null; patientId: string;
  items: { id: string; tooth: string | null; procedure: string; priceCents: string }[];
}

const SELECT = `SELECT q.id, q.group_id AS "groupId", q.version, q.status, q.notes, to_char(q.valid_until, 'YYYY-MM-DD') AS "validUntil",
    q.created_at AS "createdAt", q.presented_at AS "presentedAt", q.decided_at AS "decidedAt", q.accepted_by_name AS "acceptedByName",
    q.accepted_by_role AS "acceptedByRole", q.decision_note AS "decisionNote", q.patient_id AS "patientId",
    uc.name AS "createdByName", ud.name AS "decidedByName",
    COALESCE((SELECT json_agg(json_build_object('id', i.id, 'tooth', i.tooth, 'procedure', i.procedure, 'priceCents', i.price_cents::text) ORDER BY i.position)
                FROM dental_quote_items i WHERE i.tenant_id = q.tenant_id AND i.quote_id = q.id), '[]'::json) AS items
  FROM dental_quotes q
  LEFT JOIN users uc ON uc.tenant_id = q.tenant_id AND uc.id = q.created_by
  LEFT JOIN users ud ON ud.tenant_id = q.tenant_id AND ud.id = q.decided_by`;

const total = (q: Pick<QuoteRow, 'items'>) => q.items.reduce((a, i) => a + BigInt(i.priceCents), 0n).toString();
const withTotal = (q: QuoteRow) => ({ ...q, totalCents: total(q) });

async function loadQuote(ctx: ClinicCtx, id: string, lock = false) {
  const r = await ctx.tx.query<QuoteRow>(`${SELECT} WHERE q.id = $1${lock ? ' FOR UPDATE OF q' : ''}`, [id]);
  if (!r.rows[0]) throw notFound('Orçamento não encontrado.');
  return r.rows[0];
}

async function insertItems(ctx: ClinicCtx, quoteId: string, list: z.infer<typeof items>) {
  for (const [pos, i] of list.entries()) {
    await ctx.tx.query(
      'INSERT INTO dental_quote_items (tenant_id, quote_id, position, tooth, procedure, price_cents) VALUES ($1,$2,$3,$4,$5,$6)',
      [ctx.tenantId, quoteId, pos, i.tooth, i.procedure, i.priceCents]);
  }
}

export function dentalQuoteRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/patients/:id/dental-quotes', { ...CAP, perm: 'dental.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query<QuoteRow>(
      `${SELECT} WHERE q.patient_id = ANY($1::uuid[]) ORDER BY q.created_at DESC, q.version DESC LIMIT 100`, [await family(ctx.tx, id)]);
    return { quotes: r.rows.map(withTotal) };
  });

  clinicRoute(app, 'POST', '/api/patients/:id/dental-quotes', { ...CAP, perm: 'dental.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ items, notes: z.string().trim().max(500).optional(), validUntil: ymd.optional() }).parse(ctx.req.body);
    await assertActive(ctx.tx, id);
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO dental_quotes (tenant_id, patient_id, group_id, version, notes, valid_until, created_by)
         VALUES ($1,$2,$3,1,$4,$5,$6) RETURNING id`, [ctx.tenantId, id, randomUUID(), b.notes ?? null, b.validUntil ?? null, ctx.user.id]);
      await insertItems(ctx, r.rows[0]!.id, b.items);
      await audit(ctx, 'dental.quote.create', 'dental_quote', r.rows[0]!.id, { patientId: id, version: 1 });
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });

  // Edita o rascunho (troca a lista de procedimentos). Orçamento apresentado não muda: gera-se uma nova versão.
  clinicRoute(app, 'PATCH', '/api/dental-quotes/:id', { ...CAP, perm: 'dental.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ items: items.optional(), notes: z.string().trim().max(500).nullish(), validUntil: ymd.nullish() }).parse(ctx.req.body);
    const q = await loadQuote(ctx, id, true);
    if (q.status !== 'draft') throw conflict('Só o rascunho pode ser editado. Crie uma nova versão para alterar um orçamento apresentado.');
    try {
      if (b.items) {
        await ctx.tx.query('DELETE FROM dental_quote_items WHERE quote_id = $1', [id]);
        await insertItems(ctx, id, b.items);
      }
      await ctx.tx.query('UPDATE dental_quotes SET notes = $2, valid_until = $3 WHERE id = $1', [
        id, b.notes === undefined ? q.notes : b.notes, b.validUntil === undefined ? q.validUntil : b.validUntil]);
      await audit(ctx, 'dental.quote.edit', 'dental_quote', id);
      return { ok: true };
    } catch (e) { return mapDbError(e); }
  });

  // Apresenta ao paciente: congela o conteúdo e substitui a versão apresentada anteriormente.
  clinicRoute(app, 'POST', '/api/dental-quotes/:id/present', { ...CAP, perm: 'dental.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const q = await loadQuote(ctx, id, true);
    if (q.status !== 'draft') throw conflict('Este orçamento já foi apresentado.');
    if (q.items.length === 0 || BigInt(total(q)) <= 0n) throw badRequest('O orçamento precisa ter valor para ser apresentado.');
    if (q.validUntil && q.validUntil < new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })) throw badRequest('A validade já passou. Ajuste a data no rascunho.');
    try {
      await ctx.tx.query("UPDATE dental_quotes SET status = 'superseded' WHERE group_id = $1 AND status = 'presented'", [q.groupId]);
      await ctx.tx.query(
        `UPDATE dental_quotes SET status = 'presented', presented_by = $2, presented_at = now(), valid_until = COALESCE(valid_until, ${TODAY_SP} + 30) WHERE id = $1`,
        [id, ctx.user.id]);
      await audit(ctx, 'dental.quote.present', 'dental_quote', id, { version: q.version, totalCents: total(q) });
      return { ok: true };
    } catch (e) { return mapDbError(e); }
  });

  // Nova versão (rascunho) a partir de uma versão apresentada, recusada ou substituída.
  clinicRoute(app, 'POST', '/api/dental-quotes/:id/revise', { ...CAP, perm: 'dental.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const src = await loadQuote(ctx, id, true);
    if (src.status === 'draft') throw conflict('Este orçamento já é um rascunho: edite-o.');
    if (src.status === 'accepted') throw conflict('Orçamento aceito não tem nova versão: os procedimentos já foram para o plano de tratamento.');
    const max = await ctx.tx.query<{ v: number }>('SELECT MAX(version)::int AS v FROM dental_quotes WHERE group_id = $1', [src.groupId]);
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO dental_quotes (tenant_id, patient_id, group_id, version, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [ctx.tenantId, src.patientId, src.groupId, max.rows[0]!.v + 1, src.notes, ctx.user.id]);
      await insertItems(ctx, r.rows[0]!.id, src.items.map((i) => ({ tooth: i.tooth, procedure: i.procedure, priceCents: Number(i.priceCents) })));
      await audit(ctx, 'dental.quote.revise', 'dental_quote', r.rows[0]!.id, { from: id, version: max.rows[0]!.v + 1 });
      return { id: r.rows[0]!.id, version: max.rows[0]!.v + 1 };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('Já existe um rascunho deste orçamento.');
      return mapDbError(e);
    }
  });

  clinicRoute(app, 'POST', '/api/dental-quotes/:id/accept', { ...CAP, perm: 'dental.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({
      acceptedByName: z.string().trim().min(2).max(120),
      acceptedByRole: z.enum(['patient', 'guardian']),
      note: z.string().trim().max(300).optional(),
    }).parse(ctx.req.body);
    const q = await loadQuote(ctx, id, true);
    if (q.status !== 'presented') throw conflict(q.status === 'accepted' ? 'Este orçamento já foi aceito.' : 'Só um orçamento apresentado pode ser aceito (esta versão pode ter sido substituída).');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    if (q.validUntil && q.validUntil < today) throw conflict('Orçamento vencido. Crie uma nova versão com a validade atualizada.');
    await assertActive(ctx.tx, q.patientId);
    // Paciente menor de idade: o aceite precisa ser do responsável legal.
    const p = await ctx.tx.query<{ minor: boolean | null }>(
      `SELECT (birth_date > ${TODAY_SP} - interval '18 years') AS minor FROM patients WHERE id = $1`, [q.patientId]);
    if (p.rows[0]?.minor && b.acceptedByRole !== 'guardian') throw badRequest('Paciente menor de idade: o aceite deve ser do responsável legal.');
    try {
      let created = 0;
      for (const i of q.items) {
        const r = await ctx.tx.query(
          `INSERT INTO dental_plan_items (tenant_id, patient_id, tooth, procedure, price_cents, created_by, quote_item_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, quote_item_id) DO NOTHING`,
          [ctx.tenantId, q.patientId, i.tooth, i.procedure, i.priceCents, ctx.user.id, i.id]);
        created += r.rowCount ?? 0;
      }
      await ctx.tx.query(
        `UPDATE dental_quotes SET status = 'accepted', decided_by = $2, decided_at = now(), accepted_by_name = $3, accepted_by_role = $4, decision_note = $5 WHERE id = $1`,
        [id, ctx.user.id, b.acceptedByName, b.acceptedByRole, b.note ?? null]);
      await audit(ctx, 'dental.quote.accept', 'dental_quote', id, { version: q.version, totalCents: total(q), acceptedByRole: b.acceptedByRole, planItems: created });
      return { ok: true, planItems: created };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'POST', '/api/dental-quotes/:id/reject', { ...CAP, perm: 'dental.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ reason: z.string().trim().min(3).max(300) }).parse(ctx.req.body);
    const q = await loadQuote(ctx, id, true);
    if (q.status !== 'presented') throw conflict('Só um orçamento apresentado pode ser recusado.');
    try {
      await ctx.tx.query(`UPDATE dental_quotes SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [id, ctx.user.id, b.reason]);
      await audit(ctx, 'dental.quote.reject', 'dental_quote', id, { version: q.version });
      return { ok: true };
    } catch (e) { return mapDbError(e); }
  });
}
