import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
type T = Awaited<ReturnType<typeof tenant>>;
async function item(t: T, name: string, min = 0) {
  return (await t.owner.post('/api/inventory/items', { name, unit: 'un', minQuantity: min })).json().id as string;
}
const lotsOf = async (t: T, id: string) => (await t.owner.get(`/api/inventory/items/${id}/lots`)).json().lots as { id: string; code: string; balance: string; status: string; expiresOn: string | null }[];

describe('lotes e validade', () => {
  it('entrada com lote cria o lote; mesmo lote soma; validade divergente ou vencida é recusada', async () => {
    const t = await tenant('lotin');
    const id = await item(t, 'Resina');
    const mv = (b: object) => t.owner.post('/api/inventory/movements', { itemId: id, kind: 'in', ...b });
    expect((await mv({ quantity: 10, lotCode: 'L1', expiresOn: day(60) })).statusCode).toBe(200);
    expect((await mv({ quantity: 5, lotCode: 'L1', expiresOn: day(60) })).statusCode).toBe(200);    // mesmo lote
    expect((await mv({ quantity: 5, lotCode: 'L1', expiresOn: day(90) })).statusCode).toBe(409);    // outra validade para o mesmo lote
    expect((await mv({ quantity: 5, lotCode: 'L2', expiresOn: day(-1) })).statusCode).toBe(400);    // já vencida
    expect((await mv({ quantity: 5, expiresOn: day(10) })).statusCode).toBe(400);                   // validade sem lote
    expect((await t.owner.post('/api/inventory/movements', { itemId: id, kind: 'out', quantity: 1, lotCode: 'L1' })).statusCode).toBe(400); // lote só na entrada
    const lots = await lotsOf(t, id);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ code: 'L1', balance: '15.000', status: 'ok' });
  });

  it('saída consome primeiro o que vence antes (FEFO), atravessa lotes e usa o saldo sem lote por último', async () => {
    const t = await tenant('lotfefo');
    const id = await item(t, 'Anestésico');
    const inn = (b: object) => t.owner.post('/api/inventory/movements', { itemId: id, kind: 'in', ...b });
    await inn({ quantity: 4 });                                        // sem lote
    await inn({ quantity: 5, lotCode: 'TARDE', expiresOn: day(200) });
    await inn({ quantity: 3, lotCode: 'CEDO', expiresOn: day(20) });
    const out = await t.owner.post('/api/inventory/movements', { itemId: id, kind: 'out', quantity: 9, idempotencyKey: 'fefo-key-0001' });
    expect(out.statusCode).toBe(200);
    expect(out.json().ids).toHaveLength(3);                           // 3 de CEDO, 5 de TARDE, 1 sem lote
    const lots = await lotsOf(t, id);
    expect(lots.find((l) => l.code === 'CEDO')!.balance).toBe('0.000');
    expect(lots.find((l) => l.code === 'TARDE')!.balance).toBe('0.000');
    expect(out.json().balance).toBe('3.000');                         // sobraram 3 sem lote
    // repetir a mesma chave não baixa de novo
    const again = await t.owner.post('/api/inventory/movements', { itemId: id, kind: 'out', quantity: 9, idempotencyKey: 'fefo-key-0001' });
    expect(again.json().duplicate).toBe(true);
    expect((await t.owner.post('/api/inventory/movements', { itemId: id, kind: 'out', quantity: 4 })).statusCode).toBe(409); // só restam 3
  });

  it('lote vencido: não sai em uso, não conta para o mínimo, aparece nos alertas e é baixado por ajuste', async () => {
    const t = await tenant('lotexp');
    const id = await item(t, 'Adesivo', 5);
    await t.owner.post('/api/inventory/movements', { itemId: id, kind: 'in', quantity: 4, lotCode: 'NOVO', expiresOn: day(15) });
    // lote já vencido, criado direto (a API recusa entrada vencida)
    await withTenant(appPool, t.id, async (tx) => {
      const u = (await tx.query<{ id: string }>('SELECT id FROM users LIMIT 1')).rows[0]!.id;
      const l = (await tx.query<{ id: string }>(`INSERT INTO inventory_lots (tenant_id, item_id, code, expires_on, created_by) VALUES ($1,$2,'VELHO',$3,$4) RETURNING id`, [t.id, id, day(-3), u])).rows[0]!.id;
      await tx.query(`INSERT INTO inventory_movements (tenant_id, item_id, kind, delta, created_by, lot_id) VALUES ($1,$2,'in',10,$3,$4)`, [t.id, id, u, l]);
    });
    const list = (await t.owner.get('/api/inventory/items')).json();
    expect(list.items[0]).toMatchObject({ balance: '14.000', expiredQty: '10.000', usableBalance: '4', low: true, expired: true, expiringSoon: true });
    expect(list.expiredCount).toBe(1); expect(list.expiringCount).toBe(1);

    const lots = await lotsOf(t, id);
    const old = lots.find((l) => l.code === 'VELHO')!;
    expect(old.status).toBe('expired');
    expect(lots.find((l) => l.code === 'NOVO')!.status).toBe('expiring');

    // saída automática não toca no vencido; mais do que o utilizável é recusado
    expect((await t.owner.post('/api/inventory/movements', { itemId: id, kind: 'out', quantity: 5 })).statusCode).toBe(409);
    expect((await t.owner.post('/api/inventory/movements', { itemId: id, kind: 'out', quantity: 1, lotId: old.id })).statusCode).toBe(409);
    expect((await t.owner.post('/api/inventory/movements', { itemId: id, kind: 'out', quantity: 4 })).statusCode).toBe(200);
    // descarte: ajuste explicado no lote vencido
    const disc = await t.owner.post('/api/inventory/movements', { itemId: id, kind: 'adjust', quantity: -10, lotId: old.id, reason: 'Descarte por vencimento' });
    expect(disc.statusCode).toBe(200);
    expect((await lotsOf(t, id)).find((l) => l.code === 'VELHO')!.balance).toBe('0.000');
    expect((await t.owner.get('/api/inventory/items')).json().expiredCount).toBe(0);
  });

  it('o banco recusa lote de outro item e saldo negativo no lote; lotes são imutáveis; isolamento entre clínicas', async () => {
    const t = await tenant('lotdb');
    const a = await item(t, 'Item A');
    const b = await item(t, 'Item B');
    await t.owner.post('/api/inventory/movements', { itemId: a, kind: 'in', quantity: 2, lotCode: 'LA', expiresOn: day(40) });
    await t.owner.post('/api/inventory/movements', { itemId: b, kind: 'in', quantity: 9 });
    const lotA = (await lotsOf(t, a))[0]!.id;
    expect((await t.owner.post('/api/inventory/movements', { itemId: b, kind: 'adjust', quantity: -1, lotId: lotA, reason: 'lote trocado' })).statusCode).toBe(404);
    expect((await t.owner.post('/api/inventory/movements', { itemId: a, kind: 'adjust', quantity: -3, lotId: lotA, reason: 'além do saldo' })).statusCode).toBe(409);
    const run = (sql: string) => withTenant(appPool, t.id, (tx) => tx.query(sql));
    await expect(run("UPDATE inventory_lots SET code = 'X'")).rejects.toThrow(/permission denied|append-only/);
    await expect(run('DELETE FROM inventory_lots')).rejects.toThrow(/permission denied|append-only/);
    // direto no SQL: lote de outro item
    await expect(withTenant(appPool, t.id, (tx) => tx.query(
      `INSERT INTO inventory_movements (tenant_id, item_id, kind, delta, created_by, lot_id) SELECT $1, $2, 'in', 1, id, $3 FROM users WHERE tenant_id = $1 LIMIT 1`, [t.id, b, lotA]))).rejects.toThrow(/não pertence/);

    const other = await tenant('lotother');
    expect((await other.owner.get(`/api/inventory/items/${a}/lots`)).statusCode).toBe(404);
  });
});
