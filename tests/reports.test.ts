import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
let seq = 0;
const key = () => `rep-key-${Date.now()}-${seq++}`;

describe('indicadores', () => {
  it('somam os dados do período e respeitam fuso, plano e perfil', async () => {
    const t = await tenant('rep');
    const dr = await t.mk('professional', 'dr');
    const proId = ((await t.owner.get('/api/professionals')).json().professionals as { id: string }[])[0]!.id;
    const p1 = (await t.owner.post('/api/patients', { name: 'Indicador Um' })).json().id as string;
    const p2 = (await t.owner.post('/api/patients', { name: 'Indicador Dois' })).json().id as string;

    // 4 consultas hoje: 2 concluídas, 1 falta, 1 cancelada → taxa de falta = 1/(2+1) = 33,3%
    const slot = (h: number) => new Date(`${today()}T${String(h).padStart(2, '0')}:00:00-03:00`).toISOString();
    const mk = async (h: number, patientId: string) => (await t.owner.post('/api/appointments', { patientId, professionalId: proId, startsAt: slot(h), endsAt: slot(h + 1), service: 'Consulta', priceCents: 10000, encaixe: true })).json().id as string;
    const [a1, a2, a3, a4] = [await mk(8, p1), await mk(10, p2), await mk(12, p1), await mk(14, p2)];
    for (const a of [a1, a2]) for (const status of ['checked_in', 'completed']) expect((await t.owner.patch(`/api/appointments/${a}`, { status })).statusCode).toBe(200);
    expect((await t.owner.patch(`/api/appointments/${a3}`, { status: 'no_show' })).statusCode).toBe(200);
    expect((await t.owner.patch(`/api/appointments/${a4}`, { status: 'cancelled', reason: 'Imprevisto' })).statusCode).toBe(200);

    // dinheiro: 2 cobranças de 100 (concluídas), pagamento Pix 60, estorno 10, desconto aprovado 15
    expect((await t.owner.post('/api/finance/movements', { patientId: p1, kind: 'payment', method: 'pix', amountCents: 6000, idempotencyKey: key() })).statusCode).toBe(200);
    expect((await t.owner.post('/api/finance/movements', { patientId: p1, kind: 'refund', method: 'pix', amountCents: 1000, idempotencyKey: key() })).statusCode).toBe(200);
    const dreq = (await t.owner.post('/api/finance/discount-requests', { patientId: p2, amountCents: 1500, reason: 'Cortesia de teste' })).json().id as string;
    expect((await t.owner.post(`/api/finance/discount-requests/${dreq}/decide`, { decision: 'approve' })).statusCode).toBe(200);

    // CRM e estoque
    const lead = (await t.owner.post('/api/crm/leads', { name: 'Lead Indicador', phone: '11999990000', source: 'google' })).json().id as string;
    await t.owner.post('/api/crm/leads', { name: 'Lead Dois', phone: '11999990001', source: 'google' });
    expect((await t.owner.post(`/api/crm/leads/${lead}/convert`, { confirmNotDuplicate: true })).statusCode).toBe(200);
    const item = (await t.owner.post('/api/inventory/items', { name: 'Luva', minQuantity: 5 })).json().id as string;
    await t.owner.post('/api/inventory/movements', { itemId: item, kind: 'in', quantity: 4 });
    await t.owner.post('/api/inventory/movements', { itemId: item, kind: 'out', quantity: 1 });

    const r = (await t.owner.get(`/api/reports/overview?from=${today()}&to=${today()}`)).json();
    expect(r.omitted).toEqual([]);
    expect(r.sections.appointments).toMatchObject({ total: 4, byStatus: { completed: 2, no_show: 1, cancelled: 1 }, noShowRate: 33.3 });
    expect(r.sections.appointments.byProfessional[0]).toMatchObject({ total: 4, completed: 2, noShow: 1, cancelled: 1 });
    expect(r.sections.patients.newPatients).toBe(3); // dois pacientes + o paciente criado pela conversão do lead
    expect(r.sections.finance).toMatchObject({ chargedCents: '20000', receivedCents: '5000', refundedCents: '1000', discountsCents: '1500' });
    expect(r.sections.finance.byMethod.find((m: { method: string }) => m.method === 'pix').receivedCents).toBe('5000');
    expect(r.sections.finance.outstandingCents).toBe('13500'); // 100−60+10 (p1) e 100−15 (p2) → 50 + 85
    expect(r.sections.finance.cash).toMatchObject({ closedSessions: 0, pendingDiscounts: 0 });
    expect(r.sections.crm).toMatchObject({ created: 2, conversionRate: 50, byStage: { won: 1, new: 1 } });
    expect(r.sections.crm.bySource[0]).toMatchObject({ source: 'google', n: 2, won: 1 });
    expect(r.sections.inventory).toMatchObject({ activeItems: 1, lowStock: 1, entries: 1, exits: 1 });

    // período sem movimento: zerado; só o que é "estado atual" (em aberto, estoque baixo) continua aparecendo
    const old = (await t.owner.get(`/api/reports/overview?from=${shift(today(), -30)}&to=${shift(today(), -10)}`)).json();
    expect(old.sections.appointments.total).toBe(0);
    expect(old.sections.appointments.noShowRate).toBeNull();
    expect(old.sections.finance.chargedCents).toBe('0');
    expect(old.sections.crm.conversionRate).toBeNull();

    // validação do período
    expect((await t.owner.get(`/api/reports/overview?from=${today()}&to=${shift(today(), -1)}`)).statusCode).toBe(400);
    expect((await t.owner.get(`/api/reports/overview?from=${shift(today(), -400)}&to=${today()}`)).statusCode).toBe(400);
    expect((await t.owner.get('/api/reports/overview?from=ontem&to=hoje')).statusCode).toBe(400);
    expect((await dr.c.get(`/api/reports/overview?from=${today()}&to=${today()}`)).statusCode).toBe(403); // profissional não vê indicadores
  });

  it('cada perfil vê só as seções a que tem direito; plano sem BI não tem indicadores', async () => {
    const t = await tenant('repsec');
    const mkt = await t.mk('marketing', 'mkt');
    const aud = await t.mk('auditor', 'aud');
    const fin = await t.mk('finance', 'fabio');
    const q = `from=${today()}&to=${today()}`;
    const section = async (c: typeof mkt.c) => { const j = (await c.get(`/api/reports/overview?${q}`)).json(); return { has: Object.keys(j.sections).sort(), omitted: (j.omitted as { section: string }[]).map((o) => o.section).sort() }; };
    expect((await section(mkt.c)).has).toEqual(['crm']);
    expect((await section(aud.c)).has).toEqual(['finance', 'inventory']);
    expect((await section(fin.c)).has).toEqual(['finance']);
    expect((await section(aud.c)).omitted).toEqual(['appointments', 'crm', 'patients']);

    const solo = await tenant('repplan', 'essencial');
    expect((await solo.owner.get(`/api/reports/overview?${q}`)).json().error).toBe('capability_unavailable');
    const gestao = await tenant('repgestao', 'gestao');
    const g = (await gestao.owner.get(`/api/reports/overview?${q}`)).json();
    expect(g.omitted).toEqual([]); // o plano Gestão inclui todos os recursos que viram seções
    expect(Object.keys(g.sections)).toContain('inventory');

    const other = await tenant('repiso');
    const o = (await other.owner.get(`/api/reports/overview?${q}`)).json();
    expect(o.sections.finance.chargedCents).toBe('0'); // outra clínica não enxerga os dados desta
    expect(o.sections.patients.totalActive).toBe(0);
  });
});
