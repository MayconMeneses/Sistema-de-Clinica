import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

let seq = 0;
const key = () => `inv-key-${Date.now()}-${seq++}`;
type Cl = { get: (u: string) => Promise<{ statusCode: number; json: () => any }>; post: (u: string, b?: unknown) => Promise<{ statusCode: number; json: () => any }>; patch: (u: string, b: unknown) => Promise<{ statusCode: number; json: () => any }> };
const perms = async (c: Cl) => (await c.get('/api/me')).json().permissions as string[];

describe('novos papéis', () => {
  it('cada papel recebe só o que precisa; nenhum dos novos lê prontuário', async () => {
    const t = await tenant('roles');
    const mgr = await t.mk('unit_manager', 'gerente');
    const stock = await t.mk('stock', 'estoquista');
    const mkt = await t.mk('marketing', 'mkt');
    const aud = await t.mk('auditor', 'auditor');
    const [pm, ps, pk, pa] = await Promise.all([perms(mgr.c), perms(stock.c), perms(mkt.c), perms(aud.c)]);

    expect(pm).toEqual(expect.arrayContaining(['patients.write', 'agenda.write', 'schedule.manage', 'finance.approve', 'reports.read', 'inventory.write', 'crm.write']));
    expect(pm).not.toEqual(expect.arrayContaining(['users.manage']));
    expect(pm).not.toContain('notes.read');
    expect(pm).not.toContain('patients.merge');

    expect(ps).toEqual(expect.arrayContaining(['inventory.read', 'inventory.write']));
    for (const p of ['patients.read', 'finance.read', 'notes.read', 'crm.read', 'audit.read']) expect(ps).not.toContain(p);

    expect(pk).toEqual(expect.arrayContaining(['crm.read', 'crm.write', 'reports.read']));
    for (const p of ['patients.read', 'finance.read', 'notes.read', 'inventory.read']) expect(pk).not.toContain(p);

    expect(pa).toEqual(expect.arrayContaining(['audit.read', 'finance.read', 'inventory.read', 'reports.read']));
    for (const p of ['patients.write', 'finance.write', 'finance.approve', 'inventory.write', 'crm.write', 'notes.read', 'patients.read', 'users.manage']) expect(pa).not.toContain(p);

    // o auditor lê a auditoria e não altera nada
    expect((await aud.c.get('/api/audit')).statusCode).toBe(200);
    expect((await aud.c.post('/api/patients', { name: 'Não pode' })).statusCode).toBe(403);
    expect((await aud.c.post('/api/cash/open', { openingCents: 0 })).statusCode).toBe(403);
    expect((await stock.c.get('/api/patients')).statusCode).toBe(403);
    expect((await mkt.c.get('/api/audit')).statusCode).toBe(403);
  });

  it('só o dono/administrador cria os novos papéis; papel inválido é recusado', async () => {
    const t = await tenant('rolesmk');
    const rec = await t.mk('receptionist', 'rita');
    const bad = { name: 'Fulano Teste', email: `x@${t.slug}.test`, role: 'stock', password: 'Senha-Teste-123' };
    expect((await rec.c.post('/api/users', bad)).statusCode).toBe(403);
    expect((await t.owner.post('/api/users', bad)).statusCode).toBe(200);
    expect((await t.owner.post('/api/users', { ...bad, email: `y@${t.slug}.test`, role: 'superuser' })).statusCode).toBe(400);
  });
});

describe('estoque', () => {
  it('exige o recurso no plano e perfil adequado', async () => {
    const solo = await tenant('invplan', 'essencial');
    expect((await solo.owner.get('/api/inventory/items')).json().error).toBe('capability_unavailable');
    const t = await tenant('invrbac');
    const rec = await t.mk('receptionist', 'rita');
    const aud = await t.mk('auditor', 'aud');
    expect((await rec.c.get('/api/inventory/items')).statusCode).toBe(403);
    expect((await aud.c.get('/api/inventory/items')).statusCode).toBe(200);
    expect((await aud.c.post('/api/inventory/items', { name: 'Luva' })).statusCode).toBe(403);
  });

  it('livro de movimentos: entrada, saída, ajuste explicado; saldo derivado; nunca negativo; idempotência; alerta de mínimo', async () => {
    const t = await tenant('invflow');
    const st = await t.mk('stock', 'estoquista');
    const id = (await st.c.post('/api/inventory/items', { name: 'Luva de procedimento', sku: 'LUV-M', unit: 'cx', minQuantity: 5 })).json().id as string;
    expect((await st.c.post('/api/inventory/items', { name: 'Outra luva', sku: 'LUV-M' })).statusCode).toBe(409); // SKU único

    const mv = (b: object) => st.c.post('/api/inventory/movements', { itemId: id, ...b });
    expect((await mv({ kind: 'in', quantity: 10, unitCostCents: 2500, idempotencyKey: key() })).json().balance).toBe('10.000');
    expect((await mv({ kind: 'out', quantity: 3 })).json().balance).toBe('7.000');
    expect((await mv({ kind: 'out', quantity: 8 })).statusCode).toBe(409);            // saldo insuficiente
    expect((await mv({ kind: 'out', quantity: -1 })).statusCode).toBe(400);          // sinal vem do tipo
    expect((await mv({ kind: 'out', quantity: 1, unitCostCents: 5 })).statusCode).toBe(400);
    expect((await mv({ kind: 'adjust', quantity: -2 })).statusCode).toBe(400);       // ajuste exige motivo
    expect((await mv({ kind: 'in', quantity: 0.0001 })).statusCode).toBe(400);       // no máximo 3 casas
    expect((await mv({ kind: 'adjust', quantity: -2, reason: 'Contagem física: 2 caixas danificadas' })).json().balance).toBe('5.000');
    expect((await mv({ kind: 'in', quantity: 0.5 })).json().balance).toBe('5.500');   // fração

    const k = key();
    const a = (await mv({ kind: 'in', quantity: 1, idempotencyKey: k })).json();
    const b = (await mv({ kind: 'in', quantity: 1, idempotencyKey: k })).json();
    expect(b.duplicate).toBe(true);
    expect(a.id).toBe(b.id);

    let list = (await st.c.get('/api/inventory/items')).json();
    expect(list.items[0]).toMatchObject({ name: 'Luva de procedimento', balance: '6.500', minQuantity: '5.000', low: false });
    expect((await mv({ kind: 'out', quantity: 2 })).json().balance).toBe('4.500');
    list = (await st.c.get('/api/inventory/items?lowOnly=1')).json();
    expect(list.lowCount).toBe(1);
    expect(list.items[0].low).toBe(true);

    const hist = (await st.c.get(`/api/inventory/items/${id}/movements`)).json();
    expect(hist.movements.length).toBe(6); // a entrada repetida (mesma chave) conta uma vez
    expect(hist.item.balance).toBe('4.500');
  });

  it('saídas simultâneas nunca deixam o saldo negativo; item inativo não movimenta; histórico é imutável no banco', async () => {
    const t = await tenant('invconc');
    const id = (await t.owner.post('/api/inventory/items', { name: 'Anestésico', unit: 'un' })).json().id as string;
    await t.owner.post('/api/inventory/movements', { itemId: id, kind: 'in', quantity: 10 });
    const rs = await Promise.all([1, 2, 3].map(() => t.owner.post('/api/inventory/movements', { itemId: id, kind: 'out', quantity: 6 })));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect((await t.owner.get(`/api/inventory/items/${id}/movements`)).json().item.balance).toBe('4.000');

    expect((await t.owner.patch(`/api/inventory/items/${id}`, { active: false })).statusCode).toBe(200);
    expect((await t.owner.post('/api/inventory/movements', { itemId: id, kind: 'in', quantity: 1 })).statusCode).toBe(409);
    expect(((await t.owner.get('/api/inventory/items')).json().items as unknown[]).length).toBe(0); // inativos ficam fora da lista
    expect(((await t.owner.get('/api/inventory/items?includeInactive=1')).json().items as unknown[]).length).toBe(1);
    expect((await t.owner.patch(`/api/inventory/items/${id}`, { active: true })).statusCode).toBe(200);

    const run = (sql: string) => withTenant(appPool, t.id, (tx) => tx.query(sql));
    await expect(run('UPDATE inventory_movements SET delta = 99')).rejects.toThrow(/permission denied|append-only/);
    await expect(run('DELETE FROM inventory_movements')).rejects.toThrow(/permission denied|append-only/);
    await expect(run("UPDATE inventory_items SET unit = 'cx'")).rejects.toThrow(/unidade/);
    await expect(run('DELETE FROM inventory_items')).rejects.toThrow(/permission denied|excluído/);
    // direto no SQL (sem passar pela API) o banco também recusa saldo negativo
    await expect(withTenant(appPool, t.id, (tx) => tx.query(
      `INSERT INTO inventory_movements (tenant_id, item_id, kind, delta, created_by) SELECT $1, $2, 'out', -100, id FROM users WHERE tenant_id = $1 LIMIT 1`, [t.id, id]))).rejects.toThrow(/saldo insuficiente/);
  });

  it('itens de uma clínica não aparecem nem são movimentados por outra', async () => {
    const a = await tenant('invisoa');
    const b = await tenant('invisob');
    const id = (await a.owner.post('/api/inventory/items', { name: 'Resina A2' })).json().id as string;
    expect(((await b.owner.get('/api/inventory/items')).json().items as unknown[]).length).toBe(0);
    expect((await b.owner.post('/api/inventory/movements', { itemId: id, kind: 'in', quantity: 1 })).statusCode).toBe(404);
    expect((await b.owner.get(`/api/inventory/items/${id}/movements`)).statusCode).toBe(404);
    expect((await b.owner.patch(`/api/inventory/items/${id}`, { name: 'Invadido' })).statusCode).toBe(404);
  });
});
