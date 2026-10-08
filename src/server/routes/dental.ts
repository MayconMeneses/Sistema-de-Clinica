import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute } from '../context.js';
import { assertActive, family } from '../../modules/patients/family.js';
import { consumeProcedureSupplies } from './inventory.js';
import { badRequest, conflict, mapDbError, notFound } from '../http.js';

const CAP = { cap: 'dental.odontogram' } as const;
const idParam = z.object({ id: z.string().uuid() });
const TOOTH = z.string().regex(/^(1[1-8]|2[1-8]|3[1-8]|4[1-8]|5[1-5]|6[1-5]|7[1-5]|8[1-5])$/, 'Dente inválido (numeração FDI).');
const SURFACE_CONDITIONS = ['healthy', 'caries', 'restoration', 'sealant', 'fracture'];
const CONDITIONS = [...SURFACE_CONDITIONS, 'missing', 'crown', 'endodontic', 'implant', 'extraction_planned'] as const;

const PLAN_TRANSITIONS: Record<string, string[]> = {
  planned: ['in_progress', 'done', 'cancelled'],
  in_progress: ['done', 'cancelled'],
};

export function dentalRoutes(app: FastifyInstance) {
  // Estado atual = último evento por (dente, face). O histórico completo permanece disponível.
  clinicRoute(app, 'GET', '/api/patients/:id/odontogram', { ...CAP, perm: 'dental.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query(
      `SELECT DISTINCT ON (tooth, COALESCE(surface, '')) tooth, surface, condition, note, created_at AS "createdAt"
         FROM dental_findings WHERE patient_id = ANY($1::uuid[])
        ORDER BY tooth, COALESCE(surface, ''), seq DESC`, [await family(ctx.tx, id)]);
    await audit(ctx, 'dental.read', 'patient', id);
    return { findings: r.rows };
  });

  clinicRoute(app, 'GET', '/api/patients/:id/odontogram/history', { ...CAP, perm: 'dental.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const q = z.object({ tooth: TOOTH }).parse(ctx.req.query);
    const r = await ctx.tx.query(
      `SELECT f.id, f.surface, f.condition, f.note, f.created_at AS "createdAt", u.name AS "authorName"
         FROM dental_findings f JOIN users u ON u.tenant_id = f.tenant_id AND u.id = f.recorded_by
        WHERE f.patient_id = ANY($1::uuid[]) AND f.tooth = $2 ORDER BY f.seq DESC LIMIT 100`, [await family(ctx.tx, id), q.tooth]);
    return { events: r.rows };
  });

  clinicRoute(app, 'POST', '/api/patients/:id/odontogram/findings', { ...CAP, perm: 'dental.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({
      tooth: TOOTH,
      surface: z.enum(['M', 'D', 'O', 'V', 'L']).nullish().transform((v) => v ?? null),
      condition: z.enum(CONDITIONS),
      note: z.string().trim().max(500).nullish().transform((v) => v || null),
    }).parse(ctx.req.body);
    if (b.surface && !SURFACE_CONDITIONS.includes(b.condition)) throw badRequest('Esta condição se aplica ao dente inteiro, não a uma face.');
    await assertActive(ctx.tx, id);
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO dental_findings (tenant_id, patient_id, tooth, surface, condition, note, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ctx.tenantId, id, b.tooth, b.surface, b.condition, b.note, ctx.user.id]);
      await audit(ctx, 'dental.finding', 'patient', id, { tooth: b.tooth, condition: b.condition });
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'GET', '/api/patients/:id/dental-plan', { ...CAP, perm: 'dental.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query(
      `SELECT id, tooth, procedure, price_cents::text AS "priceCents", priority, status, created_at AS "createdAt", completed_at AS "completedAt",
              COALESCE((SELECT json_agg(json_build_object('name', ii.name, 'unit', ii.unit, 'quantity', c.quantity::text, 'status', c.status) ORDER BY ii.name)
                          FROM procedure_consumptions c JOIN inventory_items ii ON ii.tenant_id = c.tenant_id AND ii.id = c.item_id
                         WHERE c.plan_item_id = dental_plan_items.id), '[]'::json) AS supplies
         FROM dental_plan_items WHERE patient_id = ANY($1::uuid[]) ORDER BY priority, created_at`, [await family(ctx.tx, id)]);
    const open = r.rows.filter((x) => x.status === 'planned' || x.status === 'in_progress');
    const totalOpen = open.reduce((acc, x) => acc + BigInt(x.priceCents), 0n);
    return { items: r.rows, openTotalCents: totalOpen.toString() };
  });

  clinicRoute(app, 'POST', '/api/patients/:id/dental-plan', { ...CAP, perm: 'dental.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({
      tooth: TOOTH.nullish().transform((v) => v ?? null),
      procedure: z.string().trim().min(2).max(160),
      priceCents: z.number().int().min(0).max(100_000_000).default(0),
      priority: z.number().int().min(1).max(3).default(2),
    }).parse(ctx.req.body);
    await assertActive(ctx.tx, id);
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO dental_plan_items (tenant_id, patient_id, tooth, procedure, price_cents, priority, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ctx.tenantId, id, b.tooth, b.procedure, b.priceCents, b.priority, ctx.user.id]);
      await audit(ctx, 'dental.plan_item.create', 'dental_plan_item', r.rows[0]!.id, { patientId: id });
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'PATCH', '/api/dental-plan/:id', { ...CAP, perm: 'dental.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({
      status: z.enum(['in_progress', 'done', 'cancelled']),
      charge: z.boolean().optional(), // ao concluir, gera a cobrança (uma única vez)
    }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ status: string; patient_id: string; price_cents: string; procedure: string }>(
      'SELECT status, patient_id, price_cents::text, procedure FROM dental_plan_items WHERE id = $1 FOR UPDATE', [id]);
    const item = cur.rows[0];
    if (!item) throw notFound('Item não encontrado.');
    if (!PLAN_TRANSITIONS[item.status]?.includes(b.status)) throw conflict(`Não é possível mudar de "${item.status}" para "${b.status}".`);
    try {
      await ctx.tx.query(
        `UPDATE dental_plan_items SET status = $1, completed_at = CASE WHEN $1 = 'done' THEN now() ELSE NULL END WHERE id = $2`, [b.status, id]);
      let charged = false;
      if (b.status === 'done' && b.charge && BigInt(item.price_cents) > 0n) {
        if (!ctx.entitlements.has('finance.basic')) throw conflict('O financeiro não está disponível no plano contratado.');
        const ins = await ctx.tx.query(
          `INSERT INTO financial_movements (tenant_id, patient_id, kind, amount_cents, note, idempotency_key, created_by, professional_id)
           VALUES ($1,$2,'charge',$3,'Procedimento odontológico concluído',$4,$5,$5) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
          [ctx.tenantId, item.patient_id, item.price_cents, `dental:${id}:charge`, ctx.user.id]);
        charged = (ins.rowCount ?? 0) > 0;
      }
      const supplies = b.status === 'done' && ctx.entitlements.has('inventory.core')
        ? await consumeProcedureSupplies(ctx.tx, ctx.tenantId, ctx.user.id, id, item.procedure) : { consumed: [], shortages: [], consumedDetails: [] };
      await audit(ctx, `dental.plan_item.${b.status}`, 'dental_plan_item', id, { charged, consumed: supplies.consumed.length, shortages: supplies.shortages.length });
      return { ok: true, charged, supplies };
    } catch (e) {
      if ((e as { status?: number }).status) throw e;
      return mapDbError(e);
    }
  });
}
