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
let seq = 0;
const key = () => `po-key-${Date.now()}-${seq++}`;

async function setup(label: string) {
  const t = await tenant(label);
  const sup = (await t.owner.post('/api/suppliers', { name: `Dental Sul ${label}`, phone: '(11) 3000-1000' })).json().id as string;
  const luva = (await t.owner.post('/api/inventory/items', { name: 'Luva', unit: 'cx' })).json().id as string;
  const resina = (await t.owner.post('/api/inventory/items', { name: 'Resina', unit: 'un' })).json().id as string;
  const mk = async (lines = [{ itemId: luva, quantity: 10, unitCostCents: 2500 }, { itemId: resina, quantity: 4, unitCostCents: 9000 }], extra: object = {}) =>
    t.owner.post('/api/purchase-orders', { supplierId: sup, lines, ...extra });
  const bal = async (item: string) => Number((await t.owner.get(`/api/inventory/items/${item}/movements`)).json().item.balance);
  return { t, sup, luva, resina, mk, bal };
}
const detail = async (t: T, id: string) => (await t.owner.get(`/api/purchase-orders/${id}`)).json() as { order: { status: string; number: number; totalCents: string }; lines: { id: string; itemId: string; quantity: string; received: string }[] };

describe('fornecedores', () => {
  it('cadastro, nome único, inativar; exige plano e perfil', async () => {
    const solo = await tenant('supplan', 'essencial');
    expect((await solo.owner.get('/api/suppliers')).json().error).toBe('capability_unavailable');
    const t = await tenant('suprbac');
    const rec = await t.mk('receptionist', 'rita');
    const stock = await t.mk('stock', 'edu');
    const aud = await t.mk('auditor', 'aud');
    expect((await rec.c.get('/api/suppliers')).statusCode).toBe(403);
    const id = (await stock.c.post('/api/suppliers', { name: 'Fornecedor A', email: 'a@forn.com' })).json().id as string;
    expect((await stock.c.post('/api/suppliers', { name: ' fornecedor a ' })).statusCode).toBe(409);   // mesmo nome (sem diferenciar caixa/espaços)
    expect((await aud.c.post('/api/suppliers', { name: 'Outro' })).statusCode).toBe(403);
    expect((await aud.c.get('/api/suppliers')).statusCode).toBe(200);
    expect((await stock.c.patch(`/api/suppliers/${id}`, { phone: '(11) 90000-0000', active: false })).statusCode).toBe(200);
    expect(((await stock.c.get('/api/suppliers')).json().suppliers as unknown[]).length).toBe(0);
    expect(((await stock.c.get('/api/suppliers?includeInactive=1')).json().suppliers as { phone: string }[])[0]!.phone).toBe('(11) 90000-0000');
  });
});

describe('pedidos de compra', () => {
  it('ciclo completo: rascunho, edição, envio, recebimento parcial e total com custo, lote e numeração', async () => {
    const { t, luva, resina, mk, bal, sup } = await setup('pofull');
    const created = await mk();
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    expect(created.json().number).toBe(1);
    expect((await mk()).json().number).toBe(2);                                    // numeração sequencial por clínica
    let d = await detail(t, id);
    expect(d.order).toMatchObject({ status: 'draft', totalCents: String(10 * 2500 + 4 * 9000) });

    // rascunho pode ser editado; itens repetidos e inativos são recusados
    expect((await t.owner.req('PUT', `/api/purchase-orders/${id}`, { supplierId: sup, lines: [{ itemId: luva, quantity: 1, unitCostCents: 1 }, { itemId: luva, quantity: 2, unitCostCents: 1 }] })).statusCode).toBe(400);
    expect((await t.owner.req('PUT', `/api/purchase-orders/${id}`, { supplierId: sup, expectedOn: day(7), note: 'Urgente', lines: [{ itemId: luva, quantity: 10, unitCostCents: 2500 }, { itemId: resina, quantity: 4, unitCostCents: 9000 }] })).statusCode).toBe(200);
    expect((await t.owner.post(`/api/purchase-orders/${id}/receive`, { idempotencyKey: key(), lines: [{ lineId: d.lines[0]!.id, quantity: 1 }] })).statusCode).toBe(409);  // antes de enviar
    expect((await t.owner.post(`/api/purchase-orders/${id}/send`)).statusCode).toBe(200);
    expect((await t.owner.post(`/api/purchase-orders/${id}/send`)).statusCode).toBe(409);
    expect((await t.owner.req('PUT', `/api/purchase-orders/${id}`, { supplierId: sup, lines: [{ itemId: luva, quantity: 1, unitCostCents: 1 }] })).statusCode).toBe(409);  // enviado não edita

    d = await detail(t, id);
    const lLuva = d.lines.find((l) => l.itemId === luva)!, lResina = d.lines.find((l) => l.itemId === resina)!;
    // recebimento parcial com lote e validade
    const k1 = key();
    const r1 = await t.owner.post(`/api/purchase-orders/${id}/receive`, { idempotencyKey: k1, lines: [{ lineId: lLuva.id, quantity: 6, lotCode: 'L-001', expiresOn: day(200) }] });
    expect(r1.json()).toMatchObject({ status: 'partial', duplicate: false });
    expect(await bal(luva)).toBe(6);
    // mesmo envio repetido não entra de novo
    expect((await t.owner.post(`/api/purchase-orders/${id}/receive`, { idempotencyKey: k1, lines: [{ lineId: lLuva.id, quantity: 6, lotCode: 'L-001', expiresOn: day(200) }] })).json().duplicate).toBe(true);
    expect(await bal(luva)).toBe(6);
    // acima do que falta
    expect((await t.owner.post(`/api/purchase-orders/${id}/receive`, { idempotencyKey: key(), lines: [{ lineId: lLuva.id, quantity: 5 }] })).statusCode).toBe(409);
    expect(await bal(luva)).toBe(6);
    // o custo do pedido e o lote vão para o livro
    const mv = (await t.owner.get(`/api/inventory/items/${luva}/movements`)).json().movements as { kind: string; unitCostCents: string; reason: string; lotCode: string }[];
    expect(mv[0]).toMatchObject({ kind: 'in', unitCostCents: '2500', reason: 'Pedido de compra nº 1', lotCode: 'L-001' });
    // cancelar com recebimento: não
    expect((await t.owner.post(`/api/purchase-orders/${id}/cancel`, { reason: 'Desistência' })).statusCode).toBe(409);
    // restante chega: pedido fecha sozinho
    const r2 = await t.owner.post(`/api/purchase-orders/${id}/receive`, { idempotencyKey: key(), lines: [{ lineId: lLuva.id, quantity: 4 }, { lineId: lResina.id, quantity: 4 }] });
    expect(r2.json().status).toBe('received');
    expect(await bal(luva)).toBe(10); expect(await bal(resina)).toBe(4);
    d = await detail(t, id);
    expect(d.order.status).toBe('received');
    expect((await t.owner.post(`/api/purchase-orders/${id}/receive`, { idempotencyKey: key(), lines: [{ lineId: lLuva.id, quantity: 1 }] })).statusCode).toBe(409);
    expect((await t.owner.post(`/api/purchase-orders/${id}/close`)).statusCode).toBe(409);
  });

  it('encerrar parcial, cancelar rascunho/enviado, e estados finais imutáveis', async () => {
    const { t, luva, resina, mk, bal } = await setup('poclose');
    const id = (await mk()).json().id as string;
    await t.owner.post(`/api/purchase-orders/${id}/send`);
    const d = await detail(t, id);
    await t.owner.post(`/api/purchase-orders/${id}/receive`, { idempotencyKey: key(), lines: [{ lineId: d.lines.find((l) => l.itemId === luva)!.id, quantity: 3 }] });
    expect((await t.owner.post(`/api/purchase-orders/${id}/close`)).statusCode).toBe(200);        // encerra sem esperar o resto
    expect((await detail(t, id)).order.status).toBe('received');
    expect(await bal(luva)).toBe(3); expect(await bal(resina)).toBe(0);

    const c1 = (await mk()).json().id as string;                                                   // rascunho cancelado
    expect((await t.owner.post(`/api/purchase-orders/${c1}/cancel`, { reason: 'x' })).statusCode).toBe(400);
    expect((await t.owner.post(`/api/purchase-orders/${c1}/cancel`, { reason: 'Pedido duplicado' })).statusCode).toBe(200);
    expect((await t.owner.post(`/api/purchase-orders/${c1}/send`)).statusCode).toBe(409);
    expect((await t.owner.post(`/api/purchase-orders/${c1}/cancel`, { reason: 'de novo' })).statusCode).toBe(409);
    const c2 = (await mk()).json().id as string;                                                   // enviado e cancelado
    await t.owner.post(`/api/purchase-orders/${c2}/send`);
    expect((await t.owner.post(`/api/purchase-orders/${c2}/cancel`, { reason: 'Fornecedor sem estoque' })).statusCode).toBe(200);
    expect(((await t.owner.get('/api/purchase-orders?status=canceled')).json().orders as unknown[]).length).toBe(2);
    expect(((await t.owner.get('/api/purchase-orders?status=open')).json().orders as unknown[]).length).toBe(0);

    const run = (sql: string) => withTenant(appPool, t.id, (tx) => tx.query(sql));
    await expect(run("UPDATE purchase_orders SET note = 'x' WHERE status = 'received'")).rejects.toThrow(/definitivo/);
    await expect(run('DELETE FROM purchase_orders')).rejects.toThrow(/cancele-o|permission denied/);
    await expect(run('DELETE FROM purchase_order_lines')).rejects.toThrow(/imutáveis|permission denied/);
  });

  it('banco protege o teto do recebimento sob concorrência; fornecedor inativo; perfis; isolamento', async () => {
    const { t, luva, mk, bal, sup } = await setup('pocon');
    const id = (await mk([{ itemId: luva, quantity: 10, unitCostCents: 100 }])).json().id as string;
    await t.owner.post(`/api/purchase-orders/${id}/send`);
    const line = (await detail(t, id)).lines[0]!.id;
    const rs = await Promise.all([1, 2, 3].map(() => t.owner.post(`/api/purchase-orders/${id}/receive`, { idempotencyKey: key(), lines: [{ lineId: line, quantity: 6 }] })));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);        // só um cabe dentro do pedido de 10
    expect(await bal(luva)).toBe(6);
    // direto no SQL: item diferente da linha e acima do pedido
    await expect(withTenant(appPool, t.id, (tx) => tx.query(
      `INSERT INTO inventory_movements (tenant_id, item_id, kind, delta, created_by, purchase_line_id) SELECT $1, $2, 'in', 5, id, $3 FROM users WHERE tenant_id = $1 LIMIT 1`, [t.id, luva, line]))).rejects.toThrow(/acima da quantidade/);

    await t.owner.patch(`/api/suppliers/${sup}`, { active: false });
    expect((await mk()).statusCode).toBe(409);                                    // fornecedor inativo
    const aud = await t.mk('auditor', 'aud');
    expect((await aud.c.get('/api/purchase-orders')).statusCode).toBe(200);
    expect((await aud.c.post(`/api/purchase-orders/${id}/cancel`, { reason: 'sem permissão' })).statusCode).toBe(403);
    const other = await tenant('poother');
    expect((await other.owner.get(`/api/purchase-orders/${id}`)).statusCode).toBe(404);
    expect(((await other.owner.get('/api/purchase-orders')).json().orders as unknown[]).length).toBe(0);
  });
});
