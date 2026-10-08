import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute } from '../context.js';
import { badRequest, conflict, mapDbError, notFound, type Tx } from '../http.js';

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

type InsertMovement = (delta: number, lotId: string | null, key: string | null) => Promise<{ rows: { id: string }[] }>;

/**
 * Saída pelo critério FEFO (Primeiro a Vencer, Primeiro a Sair): consome lotes não vencidos pela validade; o resto sai do saldo
 * sem lote. Vencido não sai. Lança conflito, sem gravar nada, se o saldo utilizável não bastar.
 */
export async function consumeFefo(tx: Tx, itemId: string, quantity: number, idempotencyKey: string | null, insert: InsertMovement): Promise<string[]> {
  const ids: string[] = [];
  const lots = await tx.query<{ id: string; bal: string }>(
    `SELECT l.id, COALESCE(SUM(m.delta), 0)::text AS bal
       FROM inventory_lots l LEFT JOIN inventory_movements m ON m.tenant_id = l.tenant_id AND m.lot_id = l.id
      WHERE l.item_id = $1 AND (l.expires_on IS NULL OR l.expires_on >= ${TODAY})
      GROUP BY l.id, l.expires_on, l.created_at HAVING COALESCE(SUM(m.delta), 0) > 0
      ORDER BY l.expires_on NULLS LAST, l.created_at`, [itemId]);
  const tot = await tx.query<{ total: string; inlots: string }>(
    `SELECT COALESCE(SUM(delta),0)::text AS total, COALESCE(SUM(delta) FILTER (WHERE lot_id IS NOT NULL),0)::text AS inlots FROM inventory_movements WHERE item_id = $1`, [itemId]);
  const expired = await tx.query<{ q: string }>(
    `SELECT COALESCE(SUM(m.delta),0)::text AS q FROM inventory_movements m JOIN inventory_lots l ON l.tenant_id = m.tenant_id AND l.id = m.lot_id WHERE m.item_id = $1 AND l.expires_on < ${TODAY}`, [itemId]);
  const unlotted = toMilli(Number(tot.rows[0]!.total)) - toMilli(Number(tot.rows[0]!.inlots));
  let need = toMilli(quantity);
  const usable = lots.rows.reduce((a, l) => a + toMilli(Number(l.bal)), 0) + unlotted;
  if (need > usable) throw conflict(Number(expired.rows[0]!.q) > 0 ? 'Saldo utilizável insuficiente: o que está vencido não pode sair.' : 'Saldo insuficiente em estoque para esta saída.');
  const keyFor = (n: number) => idempotencyKey ? (n === 0 ? idempotencyKey : `${idempotencyKey}#${n}`) : null;
  let n = 0;
  for (const l of lots.rows) {
    if (need <= 0) break;
    const take = Math.min(need, toMilli(Number(l.bal)));
    ids.push((await insert(-Number(fromMilli(take)), l.id, keyFor(n))).rows[0]!.id);
    need -= take; n++;
  }
  if (need > 0) ids.push((await insert(-Number(fromMilli(need)), null, keyFor(n))).rows[0]!.id);
  return ids;
}

export const procedureKey = (procedure: string) => procedure.trim().toLowerCase().replace(/\s+/g, ' ');

async function consumeOne(tx: Tx, tenantId: string, userId: string, planItemId: string, itemId: string, quantity: number): Promise<'consumed' | 'shortage'> {
  const key = `proc:${planItemId}:${itemId}`;
  const insert: InsertMovement = (d, lotId, k) => tx.query<{ id: string }>(
    `INSERT INTO inventory_movements (tenant_id, item_id, kind, delta, reason, idempotency_key, created_by, lot_id)
     VALUES ($1,$2,'out',$3,'Consumo em procedimento',$4,$5,$6) RETURNING id`, [tenantId, itemId, d, k, userId, lotId]);
  await tx.query('SAVEPOINT proc_consume');
  try {
    const it = await tx.query<{ active: boolean }>('SELECT active FROM inventory_items WHERE id = $1 FOR UPDATE', [itemId]);
    if (!it.rows[0]?.active) throw conflict('Item inativo.');
    await consumeFefo(tx, itemId, quantity, key, insert);
    await tx.query('RELEASE SAVEPOINT proc_consume');
    return 'consumed';
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT proc_consume');
    await tx.query('RELEASE SAVEPOINT proc_consume');
    return 'shortage';
  }
}

/**
 * Baixa o kit do procedimento concluído. Idempotente por (item do plano, material). Falta de saldo vira pendência e não
 * impede a conclusão do procedimento.
 */
export async function consumeProcedureSupplies(tx: Tx, tenantId: string, userId: string, planItemId: string, procedure: string) {
  const kit = await tx.query<{ item_id: string; quantity: string; name: string }>(
    `SELECT s.item_id, s.quantity::text, i.name FROM procedure_supplies s JOIN inventory_items i ON i.tenant_id = s.tenant_id AND i.id = s.item_id
      WHERE s.procedure_key = $1 ORDER BY i.name`, [procedureKey(procedure)]);
  const consumed: string[] = []; const shortages: string[] = [];
  for (const k of kit.rows) {
    const done = await tx.query('SELECT 1 FROM procedure_consumptions WHERE plan_item_id = $1 AND item_id = $2', [planItemId, k.item_id]);
    if (done.rowCount) continue;
    const st = await consumeOne(tx, tenantId, userId, planItemId, k.item_id, Number(k.quantity));
    await tx.query(`INSERT INTO procedure_consumptions (tenant_id, plan_item_id, item_id, quantity, status) VALUES ($1,$2,$3,$4,$5)`, [tenantId, planItemId, k.item_id, k.quantity, st]);
    (st === 'consumed' ? consumed : shortages).push(k.name);
  }
  return { consumed, shortages };
}

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
        const lotId = await ensureLot(ctx.tx, ctx.tenantId, ctx.user.id, b.itemId, b.lotCode, b.expiresOn);
        ids.push((await insert(delta, lotId, b.idempotencyKey ?? null)).rows[0]!.id);
      } else if (b.kind === 'out' && !b.lotId) {
        ids.push(...await consumeFefo(ctx.tx, b.itemId, Math.abs(b.quantity), b.idempotencyKey ?? null, insert));
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

  // ------------------------------------------------------------ kits de materiais por procedimento
  clinicRoute(app, 'GET', '/api/inventory/procedure-supplies', { ...CAP, perm: 'inventory.read' }, async (ctx) => {
    const r = await ctx.tx.query(
      `SELECT s.id, s.procedure_key AS procedure, s.item_id AS "itemId", i.name AS "itemName", i.unit, s.quantity::text AS quantity
         FROM procedure_supplies s JOIN inventory_items i ON i.tenant_id = s.tenant_id AND i.id = s.item_id
        ORDER BY s.procedure_key, lower(i.name) LIMIT 1000`);
    return { supplies: r.rows };
  });

  clinicRoute(app, 'PUT', '/api/inventory/procedure-supplies', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const b = z.object({ procedure: z.string().trim().min(2).max(160), itemId: z.string().uuid(), quantity: qty }).parse(ctx.req.body);
    const it = await ctx.tx.query('SELECT 1 FROM inventory_items WHERE id = $1', [b.itemId]);
    if (!it.rowCount) throw notFound('Item não encontrado.');
    const r = await ctx.tx.query<{ id: string }>(
      `INSERT INTO procedure_supplies (tenant_id, procedure_key, item_id, quantity, created_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, procedure_key, item_id) DO UPDATE SET quantity = EXCLUDED.quantity RETURNING id`,
      [ctx.tenantId, procedureKey(b.procedure), b.itemId, b.quantity, ctx.user.id]);
    await audit(ctx, 'inventory.procedure_supply.set', 'procedure_supply', r.rows[0]!.id, { quantity: b.quantity });
    return { id: r.rows[0]!.id };
  });

  clinicRoute(app, 'DELETE', '/api/inventory/procedure-supplies/:id', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query('DELETE FROM procedure_supplies WHERE id = $1', [id]);
    if (!r.rowCount) throw notFound('Material do kit não encontrado.');
    await audit(ctx, 'inventory.procedure_supply.remove', 'procedure_supply', id);
    return { ok: true };
  });

  // Baixas que não aconteceram por falta de saldo. Sem dados do paciente.
  clinicRoute(app, 'GET', '/api/inventory/shortages', { ...CAP, perm: 'inventory.read' }, async (ctx) => {
    const r = await ctx.tx.query(
      `SELECT c.plan_item_id AS "planItemId", c.item_id AS "itemId", i.name AS "itemName", i.unit, c.quantity::text AS quantity,
              p.procedure, c.created_at AS "createdAt"
         FROM procedure_consumptions c JOIN inventory_items i ON i.tenant_id = c.tenant_id AND i.id = c.item_id
         JOIN dental_plan_items p ON p.tenant_id = c.tenant_id AND p.id = c.plan_item_id
        WHERE c.status = 'shortage' ORDER BY c.created_at LIMIT 200`);
    return { shortages: r.rows };
  });

  // Tenta dar a baixa agora (depois de repor o estoque) ou encerra a pendência sem baixa, com motivo.
  clinicRoute(app, 'POST', '/api/inventory/shortages/:planItemId/:itemId/resolve', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const p = z.object({ planItemId: z.string().uuid(), itemId: z.string().uuid() }).parse(ctx.req.params);
    const b = z.object({ action: z.enum(['consume', 'dismiss']), note: z.string().trim().max(300).optional() }).parse(ctx.req.body);
    if (b.action === 'dismiss' && (b.note ?? '').length < 3) throw badRequest('Explique por que a baixa não será feita.');
    const c = await ctx.tx.query<{ quantity: string; status: string }>(
      'SELECT quantity::text, status FROM procedure_consumptions WHERE plan_item_id = $1 AND item_id = $2 FOR UPDATE', [p.planItemId, p.itemId]);
    if (!c.rows[0]) throw notFound('Pendência não encontrada.');
    if (c.rows[0].status !== 'shortage') throw conflict('Esta pendência já foi tratada.');
    if (b.action === 'consume') {
      const st = await consumeOne(ctx.tx, ctx.tenantId, ctx.user.id, p.planItemId, p.itemId, Number(c.rows[0].quantity));
      if (st === 'shortage') throw conflict('Ainda não há saldo utilizável suficiente para esta baixa.');
      await ctx.tx.query(`UPDATE procedure_consumptions SET status = 'consumed' WHERE plan_item_id = $1 AND item_id = $2`, [p.planItemId, p.itemId]);
    } else {
      await ctx.tx.query(`UPDATE procedure_consumptions SET status = 'resolved', note = $3, resolved_by = $4, resolved_at = now() WHERE plan_item_id = $1 AND item_id = $2`, [p.planItemId, p.itemId, b.note, ctx.user.id]);
    }
    await audit(ctx, `inventory.shortage.${b.action}`, 'inventory_item', p.itemId, { planItemId: p.planItemId });
    return { ok: true };
  });

  // ------------------------------------------------------------ inventário (contagem)
  // Uma contagem aberta por vez. O saldo de cada item é fotografado no instante em que ele é contado; ao concluir, a diferença
  // (contado − saldo no instante da contagem) vira ajuste no livro, e o que se movimentou depois da contagem é preservado.
  const countRow = `SELECT c.id, c.title, c.status, c.note, c.created_at AS "createdAt", c.finished_at AS "finishedAt", u.name AS "createdByName",
      (SELECT COUNT(*)::int FROM inventory_count_lines l WHERE l.count_id = c.id) AS "lineCount",
      (SELECT COUNT(*)::int FROM inventory_count_lines l WHERE l.count_id = c.id AND l.counted IS NOT NULL) AS "countedCount"
    FROM inventory_counts c LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.created_by`;

  clinicRoute(app, 'GET', '/api/inventory/counts', { ...CAP, perm: 'inventory.read' }, async (ctx) => {
    const r = await ctx.tx.query(`${countRow} ORDER BY c.created_at DESC LIMIT 30`);
    return { counts: r.rows };
  });

  clinicRoute(app, 'POST', '/api/inventory/counts', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const b = z.object({ title: z.string().trim().min(2).max(120).optional(), itemIds: z.array(z.string().uuid()).max(500).optional() }).parse(ctx.req.body);
    const title = b.title ?? `Inventário de ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
    try {
      const c = await ctx.tx.query<{ id: string }>('INSERT INTO inventory_counts (tenant_id, title, created_by) VALUES ($1,$2,$3) RETURNING id', [ctx.tenantId, title, ctx.user.id]);
      const id = c.rows[0]!.id;
      const ins = await ctx.tx.query(
        `INSERT INTO inventory_count_lines (tenant_id, count_id, item_id) SELECT $1, $2, i.id FROM inventory_items i WHERE i.active AND ($3::uuid[] IS NULL OR i.id = ANY($3::uuid[]))`,
        [ctx.tenantId, id, b.itemIds ?? null]);
      if (!ins.rowCount) throw badRequest('Não há itens ativos para contar.');
      await audit(ctx, 'inventory.count.start', 'inventory_count', id, { items: ins.rowCount });
      return { id, items: ins.rowCount };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('Já existe um inventário em andamento. Conclua ou cancele antes de iniciar outro.');
      if ((e as { status?: number }).status) throw e;
      return mapDbError(e);
    }
  });

  clinicRoute(app, 'GET', '/api/inventory/counts/:id', { ...CAP, perm: 'inventory.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const c = await ctx.tx.query(`${countRow} WHERE c.id = $1`, [id]);
    if (!c.rows[0]) throw notFound('Inventário não encontrado.');
    const lines = await ctx.tx.query(
      `SELECT l.item_id AS "itemId", i.name, i.sku, i.unit, l.counted::text AS counted, l.balance_at_count::text AS "balanceAtCount",
              COALESCE((SELECT SUM(m.delta) FROM inventory_movements m WHERE m.tenant_id = i.tenant_id AND m.item_id = i.id), 0)::text AS "currentBalance",
              (l.counted - l.balance_at_count)::text AS diff
         FROM inventory_count_lines l JOIN inventory_items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
        WHERE l.count_id = $1 ORDER BY lower(i.name)`, [id]);
    return { count: c.rows[0], lines: lines.rows };
  });

  clinicRoute(app, 'PUT', '/api/inventory/counts/:id/lines/:itemId', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const { id, itemId } = z.object({ id: z.string().uuid(), itemId: z.string().uuid() }).parse(ctx.req.params);
    const b = z.object({ counted: z.number().min(0).max(1_000_000).refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, 'Use no máximo 3 casas decimais.') }).parse(ctx.req.body);
    const c = await ctx.tx.query<{ status: string }>('SELECT status FROM inventory_counts WHERE id = $1 FOR SHARE', [id]);
    if (!c.rows[0]) throw notFound('Inventário não encontrado.');
    if (c.rows[0].status !== 'open') throw conflict('Este inventário já foi encerrado.');
    // Trava o item para fotografar o saldo sem corrida com saídas em andamento.
    await ctx.tx.query('SELECT 1 FROM inventory_items WHERE id = $1 FOR UPDATE', [itemId]);
    const bal = await ctx.tx.query<{ balance: string }>('SELECT COALESCE(SUM(delta),0)::text AS balance FROM inventory_movements WHERE item_id = $1', [itemId]);
    const r = await ctx.tx.query(
      `UPDATE inventory_count_lines SET counted = $3, balance_at_count = $4, counted_by = $5, counted_at = now() WHERE count_id = $1 AND item_id = $2`,
      [id, itemId, b.counted, bal.rows[0]!.balance, ctx.user.id]);
    if (!r.rowCount) throw notFound('Este item não faz parte do inventário.');
    return { itemId, counted: String(b.counted), balanceAtCount: bal.rows[0]!.balance, diff: (b.counted - Number(bal.rows[0]!.balance)).toFixed(3) };
  });

  clinicRoute(app, 'POST', '/api/inventory/counts/:id/close', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ note: z.string().trim().max(300).optional() }).parse(ctx.req.body);
    const c = await ctx.tx.query<{ status: string; title: string }>('SELECT status, title FROM inventory_counts WHERE id = $1 FOR UPDATE', [id]);
    if (!c.rows[0]) throw notFound('Inventário não encontrado.');
    if (c.rows[0].status !== 'open') throw conflict('Este inventário já foi encerrado.');
    const lines = await ctx.tx.query<{ item_id: string; counted: string; balance_at_count: string }>(
      'SELECT item_id, counted::text, balance_at_count::text FROM inventory_count_lines WHERE count_id = $1 AND counted IS NOT NULL ORDER BY item_id FOR UPDATE', [id]);
    if (!lines.rowCount) throw badRequest('Conte ao menos um item antes de concluir o inventário.');
    const notCounted = (await ctx.tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM inventory_count_lines WHERE count_id = $1 AND counted IS NULL', [id])).rows[0]!.n;
    let adjusted = 0, unchanged = 0;
    try {
      for (const l of lines.rows) {
        const diff = toMilli(Number(l.counted)) - toMilli(Number(l.balance_at_count));
        if (diff === 0) { unchanged++; continue; }
        await ctx.tx.query('SELECT 1 FROM inventory_items WHERE id = $1 FOR UPDATE', [l.item_id]);
        await applyCountAdjustment(ctx.tx, ctx.tenantId, ctx.user.id, l.item_id, diff, `Inventário: ${c.rows[0].title}`, `count:${id}:${l.item_id}`);
        adjusted++;
      }
    } catch (e) {
      if ((e as { code?: string; message?: string }).code === '23514' && /saldo insuficiente/.test((e as Error).message)) {
        throw conflict('O saldo mudou depois da contagem e o ajuste deixaria um item negativo. Conte esse item de novo.');
      }
      return mapDbError(e);
    }
    await ctx.tx.query(`UPDATE inventory_counts SET status = 'closed', finished_by = $2, finished_at = now(), note = $3 WHERE id = $1`, [id, ctx.user.id, b.note ?? null]);
    await audit(ctx, 'inventory.count.close', 'inventory_count', id, { adjusted, unchanged, notCounted });
    return { id, adjusted, unchanged, notCounted };
  });

  clinicRoute(app, 'POST', '/api/inventory/counts/:id/cancel', { ...CAP, perm: 'inventory.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const c = await ctx.tx.query<{ status: string }>('SELECT status FROM inventory_counts WHERE id = $1 FOR UPDATE', [id]);
    if (!c.rows[0]) throw notFound('Inventário não encontrado.');
    if (c.rows[0].status !== 'open') throw conflict('Este inventário já foi encerrado.');
    await ctx.tx.query(`UPDATE inventory_counts SET status = 'canceled', finished_by = $2, finished_at = now() WHERE id = $1`, [id, ctx.user.id]);
    await audit(ctx, 'inventory.count.cancel', 'inventory_count', id);
    return { ok: true };
  });
}

/**
 * Ajuste de inventário em milésimos. Aumento entra sem lote. Redução sai dos lotes pelo que vence antes (vencidos primeiro, pois é o
 * que a perda costuma ser) e, no fim, do saldo sem lote; assim nenhum lote fica negativo.
 */
async function applyCountAdjustment(tx: Tx, tenantId: string, userId: string, itemId: string, diffMilli: number, reason: string, keyBase: string) {
  const ins = (delta: number, lotId: string | null, n: number) => tx.query(
    `INSERT INTO inventory_movements (tenant_id, item_id, kind, delta, reason, idempotency_key, created_by, lot_id) VALUES ($1,$2,'adjust',$3,$4,$5,$6,$7)`,
    [tenantId, itemId, fromMilli(delta), reason, `${keyBase}#${n}`, userId, lotId]);
  if (diffMilli > 0) { await ins(diffMilli, null, 0); return; }
  let need = -diffMilli, n = 0;
  const lots = await tx.query<{ id: string; bal: string }>(
    `SELECT l.id, COALESCE(SUM(m.delta), 0)::text AS bal FROM inventory_lots l LEFT JOIN inventory_movements m ON m.tenant_id = l.tenant_id AND m.lot_id = l.id
      WHERE l.item_id = $1 GROUP BY l.id, l.expires_on, l.created_at HAVING COALESCE(SUM(m.delta), 0) > 0 ORDER BY l.expires_on NULLS LAST, l.created_at`, [itemId]);
  const tot = await tx.query<{ total: string; inlots: string }>(
    `SELECT COALESCE(SUM(delta),0)::text AS total, COALESCE(SUM(delta) FILTER (WHERE lot_id IS NOT NULL),0)::text AS inlots FROM inventory_movements WHERE item_id = $1`, [itemId]);
  const unlotted = Math.max(0, toMilli(Number(tot.rows[0]!.total)) - toMilli(Number(tot.rows[0]!.inlots)));
  const fromUnlotted = Math.min(need, unlotted);
  if (fromUnlotted > 0) { await ins(-fromUnlotted, null, n++); need -= fromUnlotted; }
  for (const l of lots.rows) {
    if (need <= 0) break;
    const take = Math.min(need, toMilli(Number(l.bal)));
    await ins(-take, l.id, n++); need -= take;
  }
  if (need > 0) await ins(-need, null, n++); // o gatilho do banco recusa se o item ficaria negativo
}

/** Lote de uma entrada: usa o existente (a validade precisa coincidir) ou cria um novo. Validade já vencida é recusada. */
export async function ensureLot(tx: Tx, tenantId: string, userId: string, itemId: string, code: string, expiresOn?: string): Promise<string> {
  if (expiresOn && expiresOn < new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })) throw badRequest('A validade informada já passou.');
  const found = await tx.query<{ id: string; expires_on: string | null }>(
    `SELECT id, to_char(expires_on, 'YYYY-MM-DD') AS expires_on FROM inventory_lots WHERE item_id = $1 AND code = $2`, [itemId, code]);
  if (found.rows[0]) {
    if (expiresOn && found.rows[0].expires_on !== expiresOn) throw conflict('Este lote já existe com outra validade.');
    return found.rows[0].id;
  }
  const l = await tx.query<{ id: string }>('INSERT INTO inventory_lots (tenant_id, item_id, code, expires_on, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [tenantId, itemId, code, expiresOn ?? null, userId]);
  return l.rows[0]!.id;
}
