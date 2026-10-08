import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

type T = Awaited<ReturnType<typeof tenant>>;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
async function item(t: T, name: string, qty: number) {
  const id = (await t.owner.post('/api/inventory/items', { name, unit: 'un' })).json().id as string;
  if (qty) await t.owner.post('/api/inventory/movements', { itemId: id, kind: 'in', quantity: qty });
  return id;
}
const balance = async (t: T, id: string) => Number((await t.owner.get(`/api/inventory/items/${id}/movements`)).json().item.balance);
const count = (t: T, id: string, item: string, counted: number) => t.owner.req('PUT', `/api/inventory/counts/${id}/lines/${item}`, { counted });

describe('inventário por contagem', () => {
  it('fluxo: abre, conta, conclui e a diferença vira ajuste; só um inventário aberto', async () => {
    const t = await tenant('invcount');
    const luva = await item(t, 'Luva', 10);
    const resina = await item(t, 'Resina', 4);
    const anest = await item(t, 'Anestésico', 7);
    const inativo = await item(t, 'Item inativo', 3);
    await t.owner.patch(`/api/inventory/items/${inativo}`, { active: false });

    const c = await t.owner.post('/api/inventory/counts', { title: 'Inventário de teste' });
    expect(c.statusCode).toBe(200);
    expect(c.json().items).toBe(3);                                       // itens ativos
    const id = c.json().id as string;
    expect((await t.owner.post('/api/inventory/counts', {})).statusCode).toBe(409);   // só um aberto

    const detail = (await t.owner.get(`/api/inventory/counts/${id}`)).json();
    expect(detail.lines).toHaveLength(3);
    expect(detail.lines.every((l: { counted: string | null }) => l.counted === null)).toBe(true);

    expect((await count(t, id, luva, 8)).json()).toMatchObject({ counted: '8', balanceAtCount: '10.000', diff: '-2.000' });   // faltam 2
    expect((await count(t, id, resina, 4)).statusCode).toBe(200);                                                           // confere
    expect((await count(t, id, resina, -1)).statusCode).toBe(400);
    expect((await count(t, id, inativo, 1)).statusCode).toBe(404);                                                          // fora do inventário

    // movimento depois da contagem é preservado: entram 5 de Luva
    await t.owner.post('/api/inventory/movements', { itemId: luva, kind: 'in', quantity: 5 });

    const closed = await t.owner.post(`/api/inventory/counts/${id}/close`, { note: 'Conferido pela equipe' });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ adjusted: 1, unchanged: 1, notCounted: 1 });
    expect(await balance(t, luva)).toBe(13);          // 10 − 2 (ajuste) + 5 (entrada posterior)
    expect(await balance(t, resina)).toBe(4);
    expect(await balance(t, anest)).toBe(7);          // não contado: intocado

    const mv = (await t.owner.get(`/api/inventory/items/${luva}/movements`)).json().movements as { kind: string; delta: string; reason: string }[];
    expect(mv.find((m) => m.kind === 'adjust')).toMatchObject({ delta: '-2.000', reason: 'Inventário: Inventário de teste' });

    expect((await t.owner.post(`/api/inventory/counts/${id}/close`, {})).statusCode).toBe(409);       // já encerrado
    expect((await count(t, id, luva, 1)).statusCode).toBe(409);
    expect((await t.owner.post(`/api/inventory/counts/${id}/cancel`, {})).statusCode).toBe(409);
    expect((await t.owner.post('/api/inventory/counts', {})).statusCode).toBe(200);                   // liberou para um novo
    expect(((await t.owner.get('/api/inventory/counts')).json().counts as unknown[]).length).toBe(2);
  });

  it('exige ao menos um item contado; cancelar não altera o saldo; sobra vira entrada', async () => {
    const t = await tenant('invcount2');
    const a = await item(t, 'Fio de sutura', 2);
    const id = (await t.owner.post('/api/inventory/counts', {})).json().id as string;
    expect((await t.owner.post(`/api/inventory/counts/${id}/close`, {})).statusCode).toBe(400);
    expect((await count(t, id, a, 0)).statusCode).toBe(200);
    expect((await t.owner.post(`/api/inventory/counts/${id}/cancel`, {})).statusCode).toBe(200);
    expect(await balance(t, a)).toBe(2);
    const id2 = (await t.owner.post('/api/inventory/counts', { itemIds: [a] })).json().id as string;
    await count(t, id2, a, 5.5);
    expect((await t.owner.post(`/api/inventory/counts/${id2}/close`, {})).statusCode).toBe(200);
    expect(await balance(t, a)).toBe(5.5);
  });

  it('itens com lote: a perda sai dos lotes que vencem antes, sem deixar lote negativo', async () => {
    const t = await tenant('invcount3');
    const id0 = (await t.owner.post('/api/inventory/items', { name: 'Adesivo', unit: 'un' })).json().id as string;
    const inn = (b: object) => t.owner.post('/api/inventory/movements', { itemId: id0, kind: 'in', ...b });
    await inn({ quantity: 2 });
    await inn({ quantity: 3, lotCode: 'CEDO', expiresOn: day(10) });
    await inn({ quantity: 5, lotCode: 'TARDE', expiresOn: day(100) });
    const cid = (await t.owner.post('/api/inventory/counts', {})).json().id as string;
    await count(t, cid, id0, 4);                                           // de 10 para 4: perda de 6
    expect((await t.owner.post(`/api/inventory/counts/${cid}/close`, {})).statusCode).toBe(200);
    expect(await balance(t, id0)).toBe(4);
    const lots = (await t.owner.get(`/api/inventory/items/${id0}/lots`)).json().lots as { code: string; balance: string }[];
    expect(lots.find((l) => l.code === 'CEDO')!.balance).toBe('0.000');    // 2 sem lote + 3 do lote que vence antes + 1 do outro
    expect(lots.find((l) => l.code === 'TARDE')!.balance).toBe('4.000');
  });

  it('perfil, plano, imutabilidade e isolamento', async () => {
    const solo = await tenant('invcountplan', 'essencial');
    expect((await solo.owner.get('/api/inventory/counts')).json().error).toBe('capability_unavailable');
    const t = await tenant('invcountrbac');
    const aud = await t.mk('auditor', 'aud');
    const a = await item(t, 'Item', 1);
    expect((await aud.c.get('/api/inventory/counts')).statusCode).toBe(200);
    expect((await aud.c.post('/api/inventory/counts', {})).statusCode).toBe(403);
    const id = (await t.owner.post('/api/inventory/counts', {})).json().id as string;
    await count(t, id, a, 1);
    await t.owner.post(`/api/inventory/counts/${id}/close`, {});
    const run = (sql: string) => withTenant(appPool, t.id, (tx) => tx.query(sql));
    await expect(run("UPDATE inventory_counts SET title = 'x'")).rejects.toThrow(/definitivo/);
    await expect(run('DELETE FROM inventory_counts')).rejects.toThrow(/cancele-o|permission denied/);
    await expect(run('UPDATE inventory_count_lines SET counted = 99')).rejects.toThrow(/encerrado/);
    const other = await tenant('invcountother');
    expect((await other.owner.get(`/api/inventory/counts/${id}`)).statusCode).toBe(404);
  });
});
