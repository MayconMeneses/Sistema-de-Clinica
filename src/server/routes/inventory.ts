import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute } from '../context.js';
import { badRequest, conflict, mapDbError, notFound } from '../http.js';

const CAP = { cap: 'inventory.core' } as const;
const idParam = z.object({ id: z.string().uuid() });
/** Quantidade com no máximo 3 casas decimais, entre 0,001 e 1.000.000. */
const qty = z.number().positive().max(1_000_000).refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, 'Use no máximo 3 casas decimais.');

/** Hoje no fuso da clínica (vencimento vale até o fim do dia da validade). */
const TODAY = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
const EXPIRING_DAYS = 30;
const ITEM_SELECT = `SELECT i.id, i.name, i.sku, i.unit, i.min_quantity::text AS "minQuantity", i.active,
    COALESCE((SELECT SUM(m.delta) FROM inventory_movements m WHERE m.tenant_id = i.tenant_id AND m.item_id = i.id), 0)::text AS balance,
    COALESCE((SELECT SUM(m.delta) FROM inventory_movements m JOIN inventory_lots l ON l.tenant_id = m.tenant_id AND l.id = m.lot_id
               WHERE m.tenant_id = i.tenant_id AND m.item_id = i.id AND l.expires_on < ${TODAY}), 0)::text AS "expiredQty",
    (SELECT to_char(MIN(l.expires_on), 'YYYY-MM-DD') FROM inventory_lots l
      WHERE l.tenant_id = i.tenant_id AND l.item_id = i.id AND l.expires_on >= ${TODAY}
        AND (SELECT COALESCE(SUM(m.delta), 0) FROM inventory_movements m WHERE m.tenant_id = l.tenant_id AND m.lot_id = l.id) > 0) AS "nextExpiry"
  FROM inventory_items i`;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a data no formato AAAA-MM-DD.');
const toMilli = (v: number) => Math.round(v * 1000);
const fromMilli = (v: number) => (v / 1000).toFixed(3);

export function inventoryRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/inventory/items', { ...CAP, perm: 'inventory.read' }, async (ctx) => {
    const q = z.object({ q: z.string().trim().max(80).optional(), lowOnly: z.enum(['1']).optional(), includeInactive: z.enum(['1']).optional() }).parse(ctx.req.query);
    const r = await ctx.tx.query<{ balance: string; minQuantity: string; expiredQty: string; nextExpiry: string | null }>(
      `SELECT * FROM (${ITEM_SELECT} WHERE ($1::text IS NULL OR i.name ILIKE $1 OR i.sku ILIKE $1) AND ($2::boolean OR i.active)) x
        ORDER BY lower(name) LIMIT 500`, [q.q ? `%${q.q.replace(/[%_]/g, '')}%` : null, q.includeInactive === '1']);
    // O mínimo considera só o que pode ser usado: quantidade vencida não conta.
    const items = r.rows.map((i) => {
      const usable = Number(i.balance) - Number(i.expiredQty);
      const days = i.nextExpiry ? Math.ceil((Date.parse(`${i.nextExpiry}T00:00:00Z`) - Date.now()) / 86_400_000) : null;
      return { ...i, usableBalance: String(usable), low: usable <= Number(i.minQuantity) && Number(i.minQuantity) > 0, expired: Number(i.expiredQty) > 0, expiringSoon: days !== null && days <= EXPIRING_DAYS };
    });
    return {
      items: q.lowOnly ? items.filter((i) => i.low) : items, lowCount: items.filter((i) => i.low).length,
      expiredCount: items.filter((i) => i.expired).length, expiringCount: items.filter((i) => i.expiringSoon).length,
    };
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
      lotCode: z.string().trim().min(1).max(40).optional(),   // entrada: informa/cria o lote
      expiresOn: dateStr.optional(),                          // entrada: validade do lote
      lotId: z.string().uuid().optional(),                    // saída/ajuste: lote específico (sem isso, sai o que vence primeiro)
    }).parse(ctx.req.body);
    if ((b.lotCode || b.expiresOn) && b.kind !== 'in') throw badRequest('Lote e validade só se informam em entradas.');
    if (b.expiresOn && !b.lotCode) throw badRequest('Informe o código do lote junto com a validade.');
    if (b.lotId && b.kind === 'in') throw badRequest('Em entradas, informe o código do lote (não o identificador).');
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
    const insert = (d: number, lotId: string | null, key: string | null) => ctx.tx.query<{ id: string }>(
      `INSERT INTO inventory_movements (tenant_id, item_id, kind, delta, unit_cost_cents, reason, idempotency_key, created_by, lot_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ctx.tenantId, b.itemId, b.kind, d, b.unitCostCents ?? null, b.reason ?? null, key, ctx.user.id, lotId]);
    try {
      const ids: string[] = [];
      if (b.kind === 'in' && b.lotCode) {
        // Entrada com lote: usa o lote existente (a validade precisa coincidir) ou cria um novo. Validade já vencida é recusada.
        if (b.expiresOn && b.expiresOn < new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10)) throw badRequest('A validade informada já passou.');
        const found = await ctx.tx.query<{ id: string; expires_on: string | null }>(
          `SELECT id, to_char(expires_on, 'YYYY-MM-DD') AS expires_on FROM inventory_lots WHERE item_id = $1 AND code = $2`, [b.itemId, b.lotCode]);
        let lotId = found.rows[0]?.id;
        if (lotId) {
          if (b.expiresOn && found.rows[0]!.expires_on !== b.expiresOn) throw conflict('Este lote já existe com outra validade.');
        } else {
          const l = await ctx.tx.query<{ id: string }>('INSERT INTO inventory_lots (tenant_id, item_id, code, expires_on, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
            [ctx.tenantId, b.itemId, b.lotCode, b.expiresOn ?? null, ctx.user.id]);
          lotId = l.rows[0]!.id;
        }
        ids.push((await insert(delta, lotId, b.idempotencyKey ?? null)).rows[0]!.id);
      } else if (b.kind === 'out' && !b.lotId) {
        // Primeiro a Vencer, Primeiro a Sair (FEFO): consome lotes não vencidos pela validade; o resto sai do saldo sem lote. Vencido não sai.
        const lots = await ctx.tx.query<{ id: string; bal: string }>(
          `SELECT l.id, COALESCE(SUM(m.delta), 0)::text AS bal
             FROM inventory_lots l LEFT JOIN inventory_movements m ON m.tenant_id = l.tenant_id AND m.lot_id = l.id
            WHERE l.item_id = $1 AND (l.expires_on IS NULL OR l.expires_on >= ${TODAY})
            GROUP BY l.id, l.expires_on, l.created_at HAVING COALESCE(SUM(m.delta), 0) > 0
            ORDER BY l.expires_on NULLS LAST, l.created_at`, [b.itemId]);
        const tot = await ctx.tx.query<{ total: string; inlots: string }>(
          `SELECT COALESCE(SUM(delta),0)::text AS total, COALESCE(SUM(delta) FILTER (WHERE lot_id IS NOT NULL),0)::text AS inlots FROM inventory_movements WHERE item_id = $1`, [b.itemId]);
        const expired = await ctx.tx.query<{ q: string }>(
          `SELECT COALESCE(SUM(m.delta),0)::text AS q FROM inventory_movements m JOIN inventory_lots l ON l.tenant_id = m.tenant_id AND l.id = m.lot_id WHERE m.item_id = $1 AND l.expires_on < ${TODAY}`, [b.itemId]);
        const unlotted = toMilli(Number(tot.rows[0]!.total)) - toMilli(Number(tot.rows[0]!.inlots));
        let need = toMilli(Math.abs(b.quantity));
        const usable = lots.rows.reduce((a, l) => a + toMilli(Number(l.bal)), 0) + unlotted;
        if (need > usable) throw conflict(Number(expired.rows[0]!.q) > 0 ? 'Saldo utilizável insuficiente: o que está vencido não pode sair.' : 'Saldo insuficiente em estoque para esta saída.');
        let n = 0;
        for (const l of lots.rows) {
          if (need <= 0) break;
          const take = Math.min(need, toMilli(Number(l.bal)));
          ids.push((await insert(-Number(fromMilli(take)), l.id, b.idempotencyKey ? (n === 0 ? b.idempotencyKey : `${b.idempotencyKey}#${n}`) : null)).rows[0]!.id);
          need -= take; n++;
        }
        if (need > 0) ids.push((await insert(-Number(fromMilli(need)), null, b.idempotencyKey ? (n === 0 ? b.idempotencyKey : `${b.idempotencyKey}#${n}`) : null)).rows[0]!.id);
      } else {
        if (b.lotId) {
          const l = await ctx.tx.query<{ expired: boolean }>(`SELECT COALESCE(expires_on < ${TODAY}, false) AS expired FROM inventory_lots WHERE id = $1 AND item_id = $2`, [b.lotId, b.itemId]);
          if (!l.rows[0]) throw notFound('Lote não encontrado neste item.');
          if (l.rows[0].expired && b.kind === 'out') throw conflict('Lote vencido não pode sair em uso: dê baixa por ajuste (descarte) com motivo.');
        }
        ids.push((await insert(delta, b.lotId ?? null, b.idempotencyKey ?? null)).rows[0]!.id);
      }
      const bal = await ctx.tx.query<{ balance: string }>('SELECT COALESCE(SUM(delta),0)::text AS balance FROM inventory_movements WHERE item_id = $1', [b.itemId]);
      await audit(ctx, `inventory.${b.kind}`, 'inventory_item', b.itemId, { delta, movementIds: ids, lot: b.lotCode ?? b.lotId ?? null });
      return { id: ids[0]!, ids, duplicate: false, balance: bal.rows[0]!.balance };
    } catch (e) {
      if ((e as { code?: string; message?: string }).code === '23514' && /saldo insuficiente/.test((e as Error).message)) throw conflict('Saldo insuficiente em estoque para esta saída.');
      return mapDbError(e);
    }
  });

  // Lotes de um item, com saldo e situação (vencido / vence em breve / ok).
  clinicRoute(app, 'GET', '/api/inventory/items/:id/lots', { ...CAP, perm: 'inventory.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const item = await ctx.tx.query(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
    if (!item.rows[0]) throw notFound('Item não encontrado.');
    const r = await ctx.tx.query<{ id: string; code: string; expiresOn: string | null; balance: string; daysLeft: number | null }>(
      `SELECT l.id, l.code, to_char(l.expires_on, 'YYYY-MM-DD') AS "expiresOn", COALESCE(SUM(m.delta), 0)::text AS balance,
              (l.expires_on - ${TODAY})::int AS "daysLeft"
         FROM inventory_lots l LEFT JOIN inventory_movements m ON m.tenant_id = l.tenant_id AND m.lot_id = l.id
        WHERE l.item_id = $1 GROUP BY l.id, l.code, l.expires_on, l.created_at
        ORDER BY (COALESCE(SUM(m.delta), 0) > 0) DESC, l.expires_on NULLS LAST, l.created_at`, [id]);
    const lots = r.rows.map((l) => ({ ...l, status: l.daysLeft === null ? 'ok' : l.daysLeft < 0 ? 'expired' : l.daysLeft <= EXPIRING_DAYS ? 'expiring' : 'ok' }));
    return { item: item.rows[0], lots };
  });

  clinicRoute(app, 'GET', '/api/inventory/items/:id/movements', { ...CAP, perm: 'inventory.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const item = await ctx.tx.query(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
    if (!item.rows[0]) throw notFound('Item não encontrado.');
    const r = await ctx.tx.query(
      `SELECT m.id, m.kind, m.delta::text AS delta, m.unit_cost_cents::text AS "unitCostCents", m.reason, m.created_at AS "createdAt", u.name AS "authorName",
              l.code AS "lotCode", to_char(l.expires_on, 'YYYY-MM-DD') AS "expiresOn"
         FROM inventory_movements m LEFT JOIN users u ON u.tenant_id = m.tenant_id AND u.id = m.created_by
         LEFT JOIN inventory_lots l ON l.tenant_id = m.tenant_id AND l.id = m.lot_id
        WHERE m.item_id = $1 ORDER BY m.created_at DESC LIMIT 100`, [id]);
    return { item: item.rows[0], movements: r.rows };
  });
}
