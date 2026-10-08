import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

type T = Awaited<ReturnType<typeof tenant>>;
const item = async (t: T, name: string) => (await t.owner.post('/api/inventory/items', { name, unit: 'un' })).json().id as string;
const stock = (t: T, itemId: string, quantity: number) => t.owner.post('/api/inventory/movements', { itemId, kind: 'in', quantity });
const balance = async (t: T, id: string) => Number(((await t.owner.get('/api/inventory/items')).json().items as { id: string; balance: string }[]).find((i) => i.id === id)!.balance);

async function setup(label: string) {
  const t = await tenant(label);
  const dr = await t.mk('professional', 'dr');
  const pid = (await dr.c.post('/api/patients', { name: 'Paciente Kit' })).json().id as string;
  const plan = async (procedure: string) => (await dr.c.post(`/api/patients/${pid}/dental-plan`, { procedure, priceCents: 10000, priority: 1 })).json().id as string;
  return { t, dr, pid, plan };
}

describe('consumo de estoque ligado ao procedimento', () => {
  it('concluir o procedimento dá baixa do kit (nome sem diferença de caixa/espaços), uma única vez', async () => {
    const { t, dr, plan } = await setup('kit');
    const resina = await item(t, 'Resina'); const luva = await item(t, 'Luvas');
    await stock(t, resina, 10); await stock(t, luva, 100);
    expect((await t.owner.req('PUT', '/api/inventory/procedure-supplies', { procedure: '  Restauração  ', itemId: resina, quantity: 1.5 })).statusCode).toBe(200);
    expect((await t.owner.req('PUT', '/api/inventory/procedure-supplies', { procedure: 'restauração', itemId: luva, quantity: 2 })).statusCode).toBe(200);
    expect((await t.owner.req('PUT', '/api/inventory/procedure-supplies', { procedure: 'restauração', itemId: luva, quantity: 4 })).statusCode).toBe(200); // atualiza, não duplica
    const kit = (await t.owner.get('/api/inventory/procedure-supplies')).json().supplies;
    expect(kit).toHaveLength(2);
    const a = await plan('RESTAURAÇÃO');
    const r = await dr.c.patch(`/api/dental-plan/${a}`, { status: 'done' });
    expect(r.statusCode).toBe(200);
    expect(r.json().supplies).toMatchObject({ consumed: ['Luvas', 'Resina'], shortages: [] });
    expect(r.json().supplies.consumedDetails).toEqual([{ name: 'Luvas', quantity: '4.000', unit: 'un' }, { name: 'Resina', quantity: '1.500', unit: 'un' }]);
    // o plano mostra o que foi baixado e o histórico do item diz de qual procedimento
    const planItem = ((await dr.c.get(`/api/patients/${(await dr.c.get('/api/patients')).json().patients[0].id}/dental-plan`)).json().items as { id: string; supplies: { name: string; status: string }[] }[]).find((i) => i.id === a)!;
    expect(planItem.supplies.map((x) => `${x.name}:${x.status}`)).toEqual(['Luvas:consumed', 'Resina:consumed']);
    const hist = (await t.owner.get(`/api/inventory/items/${resina}/movements`)).json().movements as { reason: string }[];
    expect(hist.some((m) => m.reason === 'Consumo em procedimento: RESTAURAÇÃO')).toBe(true);
    expect(await balance(t, resina)).toBe(8.5);
    expect(await balance(t, luva)).toBe(96);
    expect((await dr.c.patch(`/api/dental-plan/${a}`, { status: 'done' })).statusCode).toBe(409); // concluído é definitivo: sem segunda baixa
    expect(await balance(t, resina)).toBe(8.5);
    // procedimento sem kit não mexe no estoque
    const b = await plan('Limpeza');
    expect((await dr.c.patch(`/api/dental-plan/${b}`, { status: 'done' })).json().supplies).toMatchObject({ consumed: [], shortages: [] });
    // cancelar não consome
    const c = await plan('Restauração');
    expect((await dr.c.patch(`/api/dental-plan/${c}`, { status: 'cancelled' })).statusCode).toBe(200);
    expect(await balance(t, resina)).toBe(8.5);
  });

  it('sem saldo: o procedimento conclui, a falta vira pendência e pode ser baixada depois de repor ou encerrada com motivo', async () => {
    const { t, dr, plan } = await setup('short');
    const anest = await item(t, 'Anestésico'); const fio = await item(t, 'Fio de sutura');
    await stock(t, anest, 1);
    await t.owner.req('PUT', '/api/inventory/procedure-supplies', { procedure: 'Extração', itemId: anest, quantity: 2 });
    await t.owner.req('PUT', '/api/inventory/procedure-supplies', { procedure: 'Extração', itemId: fio, quantity: 1 });
    const a = await plan('Extração');
    const r = await dr.c.patch(`/api/dental-plan/${a}`, { status: 'done', charge: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ charged: true, supplies: { consumed: [], shortages: ['Anestésico', 'Fio de sutura'] } });
    expect(await balance(t, anest)).toBe(1);                                   // nada saiu pela metade
    const open = (await t.owner.get('/api/inventory/shortages')).json().shortages as { planItemId: string; itemId: string; procedure: string }[];
    expect(open).toHaveLength(2);
    expect(JSON.stringify(open)).not.toContain('Paciente Kit');                // sem dados do paciente
    const url = (itemId: string) => `/api/inventory/shortages/${a}/${itemId}/resolve`;
    expect((await t.owner.post(url(anest), { action: 'consume' })).statusCode).toBe(409); // ainda falta
    await stock(t, anest, 5);
    expect((await t.owner.post(url(anest), { action: 'consume' })).statusCode).toBe(200);
    expect(await balance(t, anest)).toBe(4);
    expect((await t.owner.post(url(anest), { action: 'consume' })).statusCode).toBe(409); // já tratada
    expect((await t.owner.post(url(fio), { action: 'dismiss' })).statusCode).toBe(400);   // exige motivo
    expect((await t.owner.post(url(fio), { action: 'dismiss', note: 'Usado fio da caixa antiga' })).statusCode).toBe(200);
    expect((await t.owner.get('/api/inventory/shortages')).json().shortages).toHaveLength(0);
  });

  it('kit de uma clínica não aparece em outra; kit removido deixa de baixar', async () => {
    const { t, dr, plan } = await setup('kitiso');
    const other = await tenant('kitiso2');
    const x = await item(t, 'Material');
    await stock(t, x, 3);
    expect((await t.owner.req('PUT', '/api/inventory/procedure-supplies', { procedure: 'Canal', itemId: x, quantity: 1 })).statusCode).toBe(200);
    expect((await other.owner.get('/api/inventory/procedure-supplies')).json().supplies).toHaveLength(0);
    expect((await other.owner.req('PUT', '/api/inventory/procedure-supplies', { procedure: 'Canal', itemId: x, quantity: 1 })).statusCode).toBe(404); // item de outra clínica
    const id = (await t.owner.get('/api/inventory/procedure-supplies')).json().supplies[0].id as string;
    expect((await other.owner.del(`/api/inventory/procedure-supplies/${id}`)).statusCode).toBe(404);
    expect((await t.owner.req('PUT', '/api/inventory/procedure-supplies', { procedure: 'Canal', itemId: x, quantity: 0 })).statusCode).toBe(400);
    expect((await t.owner.del(`/api/inventory/procedure-supplies/${id}`)).statusCode).toBe(200);
    const a = await plan('Canal');
    expect((await dr.c.patch(`/api/dental-plan/${a}`, { status: 'done' })).json().supplies.consumed).toEqual([]); // kit removido
    expect(await balance(t, x)).toBe(3);
  });
});
