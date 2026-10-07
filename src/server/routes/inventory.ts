import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute } from '../context.js';
import { badRequest, conflict, mapDbError, notFound } from '../http.js';

const CAP = { cap: 'inventory.core' } as const;
const idParam = z.object({ id: z.string().uuid() });
/** Quantidade com no máximo 3 casas decimais, entre 0,001 e 1.000.000. */
const qty = z.number().positive().max(1_000_000).refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, 'Use no máximo 3 casas decimais.');

const ITEM_SELECT = `SELECT i.id, i.name, i.sku, i.unit, i.min_quantity::text AS "minQuantity", i.active,
    COALESCE((SELECT SUM(m.delta) FROM inventory_movements m WHERE m.tenant_id = i.tenant_id AND m.item_id = i.id), 0)::text AS balance
  FROM inventory_items i`;

export function inventoryRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/inventory/items', { ...CAP, perm: 'inventory.read' }, async (ctx) => {
    const q = z.object({ q: z.string().trim().max(80).optional(), lowOnly: z.enum(['1']).optional(), includeInactive: z.enum(['1']).optional() }).parse(ctx.req.query);
    const r = await ctx.tx.query<{ balance: string; minQuantity: string }>(
      `SELECT * FROM (${ITEM_SELECT} WHERE ($1::text IS NULL OR i.name ILIKE $1 OR i.sku ILIKE $1) AND ($2::boolean OR i.active)) x
        ORDER BY lower(name) LIMIT 500`, [q.q ? `%${q.q.replace(/[%_]/g, '')}%` : null, q.includeInactive === '1']);
    const items = r.rows.map((i) => ({ ...i, low: Number(i.balance) <= Number(i.minQuantity) && Number(i.minQuantity) > 0 }));
    return { items: q.lowOnly ? items.filter((i) => i.low) : items, lowCount: items.filter((i) => i.low).length };
  });

  clinicRoute(app, 'POST', '/api/inventory/items', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const b = z.object({
      name: z.string().trim().min(2).max(120),
      sku: z.string().trim().min(1).max(40).optional(),
      unit: z.string().trim().min(1).max(10).default('un'),
      minQuantity: qty.or(z.literal(0)).default(0),
    }).parse(ctx.req.body);
    try {
      const r = await ctx.tx.query<{ id: string }>(
        'INSERT INTO inventory_items (tenant_id, name, sku, unit, min_quantity, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [ctx.tenantId, b.name, b.sku ?? null, b.unit, b.minQuantity, ctx.user.id]);
      await audit(ctx, 'inventory.item.create', 'inventory_item', r.rows[0]!.id);
      return { id: r.rows[0]!.id };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('Já existe um item com este código (SKU).');
      return mapDbError(e);
    }
  });

  clinicRoute(app, 'PATCH', '/api/inventory/items/:id', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ name: z.string().trim().min(2).max(120).optional(), minQuantity: qty.or(z.literal(0)).optional(), active: z.boolean().optional() }).parse(ctx.req.body);
    const r = await ctx.tx.query(
      `UPDATE inventory_items SET name = COALESCE($2, name), min_quantity = COALESCE($3, min_quantity), active = COALESCE($4, active) WHERE id = $1 RETURNING id`,
      [id, b.name ?? null, b.minQuantity ?? null, b.active ?? null]);
    if (!r.rowCount) throw notFound('Item não encontrado.');
    await audit(ctx, 'inventory.item.update', 'inventory_item', id, { active: b.active });
    return { ok: true };
  });

  clinicRoute(app, 'POST', '/api/inventory/movements', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const b = z.object({
      itemId: z.string().uuid(),
      kind: z.enum(['in', 'out', 'adjust']),
      quantity: z.number().min(-1_000_000).max(1_000_000).refine((v) => v !== 0, 'A quantidade não pode ser zero.')
        .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, 'Use no máximo 3 casas decimais.'),
      unitCostCents: z.number().int().min(0).max(100_000_000).optional(),
      reason: z.string().trim().max(200).optional(),
      idempotencyKey: z.string().trim().min(8).max(100).optional(),
    }).parse(ctx.req.body);
    if (b.kind !== 'adjust' && b.quantity < 0) throw badRequest('Informe a quantidade como número positivo.');
    if (b.kind === 'adjust' && (b.reason ?? '').length < 3) throw badRequest('Explique o motivo do ajuste.');
    if (b.kind !== 'in' && b.unitCostCents !== undefined) throw badRequest('O custo unitário só vale para entradas.');
    const delta = b.kind === 'out' ? -Math.abs(b.quantity) : b.quantity;
    const item = await ctx.tx.query<{ active: boolean }>('SELECT active FROM inventory_items WHERE id = $1 FOR UPDATE', [b.itemId]);
    if (!item.rows[0]) throw notFound('Item não encontrado.');
    if (!item.rows[0].active) throw conflict('Item inativo: reative-o para movimentar.');
    if (b.idempotencyKey) {
      const dup = await ctx.tx.query<{ id: string }>('SELECT id FROM inventory_movements WHERE idempotency_key = $1', [b.idempotencyKey]);
      if (dup.rows[0]) return { id: dup.rows[0].id, duplicate: true };
    }
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO inventory_movements (tenant_id, item_id, kind, delta, unit_cost_cents, reason, idempotency_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.tenantId, b.itemId, b.kind, delta, b.unitCostCents ?? null, b.reason ?? null, b.idempotencyKey ?? null, ctx.user.id]);
      const bal = await ctx.tx.query<{ balance: string }>('SELECT COALESCE(SUM(delta),0)::text AS balance FROM inventory_movements WHERE item_id = $1', [b.itemId]);
      await audit(ctx, `inventory.${b.kind}`, 'inventory_item', b.itemId, { delta, movementId: r.rows[0]!.id });
      return { id: r.rows[0]!.id, duplicate: false, balance: bal.rows[0]!.balance };
    } catch (e) {
      if ((e as { code?: string; message?: string }).code === '23514' && /saldo insuficiente/.test((e as Error).message)) throw conflict('Saldo insuficiente em estoque para esta saída.');
      return mapDbError(e);
    }
  });

  clinicRoute(app, 'GET', '/api/inventory/items/:id/movements', { ...CAP, perm: 'inventory.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const item = await ctx.tx.query(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
    if (!item.rows[0]) throw notFound('Item não encontrado.');
    const r = await ctx.tx.query(
      `SELECT m.id, m.kind, m.delta::text AS delta, m.unit_cost_cents::text AS "unitCostCents", m.reason, m.created_at AS "createdAt", u.name AS "authorName"
         FROM inventory_movements m LEFT JOIN users u ON u.tenant_id = m.tenant_id AND u.id = m.created_by
        WHERE m.item_id = $1 ORDER BY m.created_at DESC LIMIT 100`, [id]);
    return { item: item.rows[0], movements: r.rows };
  });
}
