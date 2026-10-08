import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute, type ClinicCtx } from '../context.js';
import { badRequest, conflict, mapDbError, notFound } from '../http.js';
import { ensureLot } from './inventory.js';

const CAP = { cap: 'inventory.core' } as const;
const idParam = z.object({ id: z.string().uuid() });
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (use AAAA-MM-DD).')
  .refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, 'Data inexistente.');
const qty = z.number().positive().max(1_000_000).refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, 'Use no máximo 3 casas decimais.');
const cost = z.number().int().min(0).max(100_000_000);
const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

const ORDER_SELECT = `SELECT o.id, o.number, o.status, to_char(o.expected_on, 'YYYY-MM-DD') AS "expectedOn", o.note, o.cancel_reason AS "cancelReason",
    o.created_at AS "createdAt", o.sent_at AS "sentAt", o.finished_at AS "finishedAt", o.supplier_id AS "supplierId", s.name AS "supplierName", u.name AS "createdByName",
    COALESCE((SELECT SUM((l.quantity * l.unit_cost_cents)::bigint) FROM purchase_order_lines l WHERE l.order_id = o.id), 0)::text AS "totalCents",
    (SELECT COUNT(*)::int FROM purchase_order_lines l WHERE l.order_id = o.id) AS "lineCount"
  FROM purchase_orders o JOIN suppliers s ON s.tenant_id = o.tenant_id AND s.id = o.supplier_id
  LEFT JOIN users u ON u.tenant_id = o.tenant_id AND u.id = o.created_by`;

async function linesOf(ctx: ClinicCtx, orderId: string) {
  const r = await ctx.tx.query(
    `SELECT l.id, l.item_id AS "itemId", i.name AS "itemName", i.unit, l.quantity::text AS quantity, l.unit_cost_cents::text AS "unitCostCents",
            COALESCE((SELECT SUM(m.delta) FROM inventory_movements m WHERE m.tenant_id = l.tenant_id AND m.purchase_line_id = l.id), 0)::text AS received
       FROM purchase_order_lines l JOIN inventory_items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
      WHERE l.order_id = $1 ORDER BY lower(i.name)`, [orderId]);
  return r.rows as { id: string; quantity: string; received: string }[];
}

const lineSchema = z.object({ itemId: z.string().uuid(), quantity: qty, unitCostCents: cost });
async function checkLines(ctx: ClinicCtx, lines: z.infer<typeof lineSchema>[]) {
  const ids = lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw badRequest('Cada item aparece uma vez no pedido.');
  const ok = await ctx.tx.query<{ n: number }>('SELECT count(*)::int AS n FROM inventory_items WHERE id = ANY($1::uuid[]) AND active', [ids]);
  if (ok.rows[0]!.n !== ids.length) throw badRequest('Há item inexistente ou inativo no pedido.');
}

export function purchasingRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ fornecedores
  clinicRoute(app, 'GET', '/api/suppliers', { ...CAP, perm: 'inventory.read' }, async (ctx) => {
    const q = z.object({ includeInactive: z.enum(['1']).optional() }).parse(ctx.req.query);
    const r = await ctx.tx.query(`SELECT id, name, phone, email, notes, active FROM suppliers WHERE ($1::boolean OR active) ORDER BY lower(name) LIMIT 300`, [q.includeInactive === '1']);
    return { suppliers: r.rows };
  });
  clinicRoute(app, 'POST', '/api/suppliers', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), phone: opt(30), email: opt(200), notes: opt(300) }).parse(ctx.req.body);
    try {
      const r = await ctx.tx.query<{ id: string }>('INSERT INTO suppliers (tenant_id, name, phone, email, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [ctx.tenantId, b.name, b.phone, b.email, b.notes, ctx.user.id]);
      await audit(ctx, 'supplier.create', 'supplier', r.rows[0]!.id);
      return { id: r.rows[0]!.id };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('Já existe um fornecedor com este nome.');
      return mapDbError(e);
    }
  });
  clinicRoute(app, 'PATCH', '/api/suppliers/:id', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ name: z.string().trim().min(2).max(120).optional(), phone: opt(30).optional(), email: opt(200).optional(), notes: opt(300).optional(), active: z.boolean().optional() }).parse(ctx.req.body);
    try {
      const r = await ctx.tx.query(
        `UPDATE suppliers SET name = COALESCE($2, name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END, email = CASE WHEN $5::boolean THEN $6 ELSE email END,
                notes = CASE WHEN $7::boolean THEN $8 ELSE notes END, active = COALESCE($9, active) WHERE id = $1`,
        [id, b.name ?? null, 'phone' in b, b.phone ?? null, 'email' in b, b.email ?? null, 'notes' in b, b.notes ?? null, b.active ?? null]);
      if (!r.rowCount) throw notFound('Fornecedor não encontrado.');
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('Já existe um fornecedor com este nome.');
      if ((e as { status?: number }).status) throw e;
      return mapDbError(e);
    }
    await audit(ctx, 'supplier.update', 'supplier', id, { active: b.active });
    return { ok: true };
  });

  // ------------------------------------------------------------ pedidos de compra
  clinicRoute(app, 'GET', '/api/purchase-orders', { ...CAP, perm: 'inventory.read' }, async (ctx) => {
    const q = z.object({ status: z.enum(['draft', 'sent', 'partial', 'received', 'canceled', 'open']).optional() }).parse(ctx.req.query);
    const r = await ctx.tx.query(
      `${ORDER_SELECT} WHERE ($1::text IS NULL OR o.status = $1 OR ($1 = 'open' AND o.status IN ('draft','sent','partial'))) ORDER BY o.number DESC LIMIT 100`, [q.status ?? null]);
    return { orders: r.rows };
  });

  clinicRoute(app, 'GET', '/api/purchase-orders/:id', { ...CAP, perm: 'inventory.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const o = await ctx.tx.query(`${ORDER_SELECT} WHERE o.id = $1`, [id]);
    if (!o.rows[0]) throw notFound('Pedido não encontrado.');
    return { order: o.rows[0], lines: await linesOf(ctx, id) };
  });

  clinicRoute(app, 'POST', '/api/purchase-orders', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const b = z.object({ supplierId: z.string().uuid(), expectedOn: ymd.nullish().transform((v) => v ?? null), note: opt(300), lines: z.array(lineSchema).min(1).max(100) }).parse(ctx.req.body);
    const sup = await ctx.tx.query<{ active: boolean }>('SELECT active FROM suppliers WHERE id = $1', [b.supplierId]);
    if (!sup.rows[0]) throw badRequest('Fornecedor inválido.');
    if (!sup.rows[0].active) throw conflict('Fornecedor inativo.');
    await checkLines(ctx, b.lines);
    try {
      const num = await ctx.tx.query<{ n: string }>(
        `INSERT INTO purchase_order_counters (tenant_id, last_number) VALUES ($1, 1) ON CONFLICT (tenant_id) DO UPDATE SET last_number = purchase_order_counters.last_number + 1 RETURNING last_number::text AS n`, [ctx.tenantId]);
      const o = await ctx.tx.query<{ id: string }>(
        'INSERT INTO purchase_orders (tenant_id, number, supplier_id, expected_on, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [ctx.tenantId, num.rows[0]!.n, b.supplierId, b.expectedOn, b.note, ctx.user.id]);
      for (const l of b.lines) {
        await ctx.tx.query('INSERT INTO purchase_order_lines (tenant_id, order_id, item_id, quantity, unit_cost_cents) VALUES ($1,$2,$3,$4,$5)', [ctx.tenantId, o.rows[0]!.id, l.itemId, l.quantity, l.unitCostCents]);
      }
      await audit(ctx, 'purchase.create', 'purchase_order', o.rows[0]!.id, { number: num.rows[0]!.n, lines: b.lines.length });
      return { id: o.rows[0]!.id, number: Number(num.rows[0]!.n) };
    } catch (e) { return mapDbError(e); }
  });

  // Rascunho: troca fornecedor, previsão, observação e a lista de itens.
  clinicRoute(app, 'PUT', '/api/purchase-orders/:id', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ supplierId: z.string().uuid(), expectedOn: ymd.nullish().transform((v) => v ?? null), note: opt(300), lines: z.array(lineSchema).min(1).max(100) }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ status: string }>('SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Pedido não encontrado.');
    if (cur.rows[0].status !== 'draft') throw conflict('Só rascunho pode ser editado.');
    const sup = await ctx.tx.query<{ active: boolean }>('SELECT active FROM suppliers WHERE id = $1', [b.supplierId]);
    if (!sup.rows[0]) throw badRequest('Fornecedor inválido.');
    await checkLines(ctx, b.lines);
    try {
      await ctx.tx.query('UPDATE purchase_orders SET supplier_id = $2, expected_on = $3, note = $4 WHERE id = $1', [id, b.supplierId, b.expectedOn, b.note]);
      await ctx.tx.query('DELETE FROM purchase_order_lines WHERE order_id = $1', [id]);
      for (const l of b.lines) await ctx.tx.query('INSERT INTO purchase_order_lines (tenant_id, order_id, item_id, quantity, unit_cost_cents) VALUES ($1,$2,$3,$4,$5)', [ctx.tenantId, id, l.itemId, l.quantity, l.unitCostCents]);
    } catch (e) { return mapDbError(e); }
    await audit(ctx, 'purchase.update', 'purchase_order', id);
    return { ok: true };
  });

  clinicRoute(app, 'POST', '/api/purchase-orders/:id/send', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const cur = await ctx.tx.query<{ status: string }>('SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Pedido não encontrado.');
    if (cur.rows[0].status !== 'draft') throw conflict('Este pedido já foi enviado.');
    await ctx.tx.query(`UPDATE purchase_orders SET status = 'sent', sent_at = now() WHERE id = $1`, [id]);
    await audit(ctx, 'purchase.send', 'purchase_order', id);
    return { ok: true };
  });

  // Recebimento: cada linha vira uma entrada no estoque (com custo do pedido, lote e validade). Repetir a mesma chave não duplica.
  clinicRoute(app, 'POST', '/api/purchase-orders/:id/receive', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({
      idempotencyKey: z.string().trim().min(8).max(80),
      lines: z.array(z.object({ lineId: z.string().uuid(), quantity: qty, lotCode: z.string().trim().min(1).max(40).optional(), expiresOn: ymd.optional() })).min(1).max(100),
    }).parse(ctx.req.body);
    const o = await ctx.tx.query<{ status: string; number: string }>('SELECT status, number::text FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!o.rows[0]) throw notFound('Pedido não encontrado.');
    const dup = await ctx.tx.query('SELECT 1 FROM inventory_movements WHERE idempotency_key = $1', [`po:${id}:${b.idempotencyKey}:${b.lines[0]!.lineId}`]);
    if (dup.rowCount) return { duplicate: true, status: o.rows[0].status };
    if (!['sent', 'partial'].includes(o.rows[0].status)) throw conflict(o.rows[0].status === 'draft' ? 'Envie o pedido antes de receber.' : 'Este pedido não está aguardando recebimento.');
    const lines = await linesOf(ctx, id);
    const byId = new Map(lines.map((l) => [l.id, l]));
    const seen = new Set<string>();
    try {
      for (const r of b.lines) {
        const l = byId.get(r.lineId) as (typeof lines[number] & { itemId: string; unitCostCents: string }) | undefined;
        if (!l) throw notFound('Linha não pertence a este pedido.');
        if (seen.has(r.lineId)) throw badRequest('Linha repetida no recebimento.');
        seen.add(r.lineId);
        if (r.expiresOn && !r.lotCode) throw badRequest('Informe o lote junto com a validade.');
        if (Math.round(r.quantity * 1000) > Math.round((Number(l.quantity) - Number(l.received)) * 1000)) throw conflict('Recebimento acima do que falta receber neste item.');
        const lotId = r.lotCode ? await ensureLot(ctx.tx, ctx.tenantId, ctx.user.id, l.itemId, r.lotCode, r.expiresOn) : null;
        await ctx.tx.query(
          `INSERT INTO inventory_movements (tenant_id, item_id, kind, delta, unit_cost_cents, reason, idempotency_key, created_by, lot_id, purchase_line_id)
           VALUES ($1,$2,'in',$3,$4,$5,$6,$7,$8,$9)`,
          [ctx.tenantId, l.itemId, r.quantity, l.unitCostCents, `Pedido de compra nº ${o.rows[0].number}`, `po:${id}:${b.idempotencyKey}:${r.lineId}`, ctx.user.id, lotId, r.lineId]);
      }
    } catch (e) {
      if ((e as { status?: number }).status) throw e;
      if ((e as { code?: string; message?: string }).code === '23514' && /acima da quantidade/.test((e as Error).message)) throw conflict('Recebimento acima do que falta receber neste item.');
      return mapDbError(e);
    }
    const after = await linesOf(ctx, id);
    const complete = after.every((l) => Number(l.received) >= Number(l.quantity));
    const status = complete ? 'received' : 'partial';
    await ctx.tx.query(`UPDATE purchase_orders SET status = $2, finished_at = CASE WHEN $2 = 'received' THEN now() END WHERE id = $1`, [id, status]);
    await audit(ctx, 'purchase.receive', 'purchase_order', id, { lines: b.lines.length, status });
    return { duplicate: false, status };
  });

  // Encerra um pedido parcial sem esperar o restante (o que faltou fica registrado como não recebido).
  clinicRoute(app, 'POST', '/api/purchase-orders/:id/close', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const cur = await ctx.tx.query<{ status: string }>('SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Pedido não encontrado.');
    if (cur.rows[0].status !== 'partial') throw conflict('Só um pedido com recebimento parcial pode ser encerrado.');
    await ctx.tx.query(`UPDATE purchase_orders SET status = 'received', finished_at = now() WHERE id = $1`, [id]);
    await audit(ctx, 'purchase.close', 'purchase_order', id);
    return { ok: true };
  });

  clinicRoute(app, 'POST', '/api/purchase-orders/:id/cancel', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ reason: z.string().trim().min(3).max(200) }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ status: string }>('SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Pedido não encontrado.');
    if (!['draft', 'sent'].includes(cur.rows[0].status)) throw conflict(cur.rows[0].status === 'canceled' ? 'Este pedido já foi cancelado.' : 'Pedido com recebimento não pode ser cancelado: encerre-o.');
    await ctx.tx.query(`UPDATE purchase_orders SET status = 'canceled', cancel_reason = $2, finished_at = now() WHERE id = $1`, [id, b.reason]);
    await audit(ctx, 'purchase.cancel', 'purchase_order', id);
    return { ok: true };
  });
}
