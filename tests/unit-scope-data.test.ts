import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { SCOPE_POLICY } from '../src/server/scope-policy.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { routeRegistry } = await import('../src/server/context.js');
const { hasPermission } = await import('../src/server/auth/rbac.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const ids = (r: { json: () => any }, key: string) => (r.json()[key] as { id: string }[]).map((x) => x.id).sort();

async function setup() {
  const t = await tenant('uscope2');
  const unitA = (await t.owner.post('/api/units', { name: 'Unidade A' })).json().id as string;
  const unitB = (await t.owner.post('/api/units', { name: 'Unidade B' })).json().id as string;
  const roomA = (await t.owner.post('/api/resources', { unitId: unitA, name: 'Sala A1', kind: 'room' })).json().id as string;
  const roomB = (await t.owner.post('/api/resources', { unitId: unitB, name: 'Sala B1', kind: 'room' })).json().id as string;
  const prA = await t.mk('professional', 'dra-a2');
  const prB = await t.mk('professional', 'dr-b2');
  const mgr = await t.mk('unit_manager', 'gerente-a2');
  const users = (await t.owner.get('/api/users')).json().users as { id: string; email: string }[];
  const idOf = (e: string) => users.find((u) => u.email === e)!.id;
  const idPro = idOf(prA.email);
  await t.owner.patch(`/api/users/${idPro}`, { unitIds: [unitA] });
  await t.owner.patch(`/api/users/${idOf(mgr.email)}`, { unitIds: [unitA] });
  const proB = idOf(prB.email);
  await t.owner.patch(`/api/users/${proB}`, { unitIds: [unitB] });
  const patient = async (name: string, birth = '1990-01-01') => (await t.owner.post('/api/patients', { name, birthDate: birth, confirmNotDuplicate: true })).json().id as string;
  let h = 0;
  const book = async (patientId: string, professionalId: string, resourceId: string) => {
    const startsAt = new Date(Date.UTC(2032, 5, 1, 9 + h++, 0)).toISOString();
    const r = await t.owner.post('/api/appointments', { patientId, professionalId, resourceId, startsAt, endsAt: new Date(Date.parse(startsAt) + 1800_000).toISOString(), service: 'Consulta', encaixe: true });
    expect(r.statusCode).toBe(200);
  };
  const pOwn = await patient('Paciente Da Unidade A', '1991-02-02');
  const pOther = await patient('Paciente Da Unidade B', '1992-03-03');
  const pNone = await patient('Paciente Sem Consulta', '1993-04-04');
  await book(pOwn, idPro, roomA);
  await book(pOther, proB, roomB);
  return { t, unitA, unitB, mgr, pOwn, pOther, pNone, book, idPro, roomA };
}

describe('escopo por unidade: pacientes e o que depende deles', () => {
  it('o gerente só enxerga pacientes com consulta na sua unidade ou cadastrados por ele', async () => {
    const s = await setup();
    expect(ids(await s.mgr.c.get('/api/patients'), 'patients')).toEqual([s.pOwn]);
    expect(ids(await s.t.owner.get('/api/patients'), 'patients')).toHaveLength(3);
    for (const p of [s.pOther, s.pNone]) {
      expect((await s.mgr.c.get(`/api/patients/${p}`)).statusCode).toBe(404);
      expect((await s.mgr.c.patch(`/api/patients/${p}`, { phone: '1' })).statusCode).toBe(404);
      expect((await s.mgr.c.get(`/api/patients/${p}/documents`)).statusCode).toBe(404);
      expect((await s.mgr.c.get(`/api/patients/${p}/forms`)).statusCode).toBe(404);
      expect((await s.mgr.c.get(`/api/patients/${p}/finance`)).statusCode).toBe(404);
      expect((await s.mgr.c.get(`/api/patients/${p}/messages`)).statusCode).toBe(404);
      expect((await s.mgr.c.get(`/api/patients/${p}/guardians`)).statusCode).toBe(404);
      expect((await s.mgr.c.get(`/api/patients/${p}/consents`)).statusCode).toBe(404);
      expect((await s.mgr.c.post(`/api/patients/${p}/portal-invite`)).statusCode).toBe(404);
      expect((await s.mgr.c.post(`/api/patients/${p}/triage`, { weightKg: 70 })).statusCode).toBe(404);
    }
    expect((await s.mgr.c.get(`/api/patients/${s.pOwn}`)).statusCode).toBe(200);
    // cadastrar: o gerente passa a enxergar o que criou, e não é avisado de duplicata entre pacientes que não vê
    const dup = await s.mgr.c.post('/api/patients', { name: 'Paciente Da Unidade B', birthDate: '1992-03-03' });
    expect(dup.statusCode).toBe(200);
    const mine = dup.json().id as string;
    expect(ids(await s.mgr.c.get('/api/patients'), 'patients')).toEqual([s.pOwn, mine].sort());
    // e o dono é avisado normalmente
    expect((await s.t.owner.post('/api/patients', { name: 'Paciente Da Unidade B', birthDate: '1992-03-03' })).statusCode).toBe(409);
    // painel conta só os visíveis
    expect((await s.mgr.c.get('/api/dashboard')).json().patients).toBe(2);
    expect((await s.t.owner.get('/api/dashboard')).json().patients).toBe(4);
  });

  it('documentos, formulários, financeiro e agendamento seguem a visibilidade do paciente', async () => {
    const s = await setup();
    const pdf = Buffer.from('%PDF-1.4\nx\n%%EOF').toString('base64');
    const docOwn = (await s.t.owner.post(`/api/patients/${s.pOwn}/documents`, { title: 'Termo', category: 'other', fileName: 'a.pdf', contentBase64: pdf })).json().id as string;
    const docOther = (await s.t.owner.post(`/api/patients/${s.pOther}/documents`, { title: 'Termo B', category: 'other', fileName: 'b.pdf', contentBase64: pdf })).json().id as string;
    expect((await s.mgr.c.get(`/api/documents/${docOwn}/download`)).statusCode).toBe(200);
    expect((await s.mgr.c.get(`/api/documents/${docOther}/download`)).statusCode).toBe(404);
    expect((await s.mgr.c.post(`/api/documents/${docOther}/archive`, { reason: 'x' })).statusCode).toBe(404);
    expect((await s.mgr.c.post(`/api/documents/${docOther}/share`, { shared: true })).statusCode).toBe(404);
    // formulários
    await s.t.owner.post('/api/form-templates/defaults', {});
    const tpl = ((await s.t.owner.get('/api/form-templates')).json().templates as { id: string }[])[0]!.id;
    expect((await s.mgr.c.post(`/api/patients/${s.pOwn}/forms`, { templateId: tpl })).statusCode).toBe(200);
    const fOther = (await s.t.owner.post(`/api/patients/${s.pOther}/forms`, { templateId: tpl })).json().id as string;
    expect((await s.mgr.c.get(`/api/forms/${fOther}`)).statusCode).toBe(404);
    expect((await s.mgr.c.post(`/api/forms/${fOther}/cancel`)).statusCode).toBe(404);
    // financeiro do paciente e dados da clínica inteira
    expect((await s.mgr.c.get(`/api/patients/${s.pOwn}/finance`)).statusCode).toBe(200);
    for (const u of ['/api/finance/summary', '/api/cash/current', '/api/cash/sessions', '/api/payables', '/api/suppliers', '/api/purchase-orders', '/api/inventory/counts', '/api/inventory/shortages']) {
      expect((await s.mgr.c.get(u)).statusCode, u).toBe(403);
    }
    expect((await s.t.owner.get('/api/finance/summary')).statusCode).toBe(200);
    // agendar paciente que não enxerga
    const startsAt = new Date(Date.UTC(2032, 6, 1, 9)).toISOString();
    const body = (patientId: string) => ({ patientId, professionalId: s.idPro, resourceId: s.roomA, startsAt, endsAt: new Date(Date.parse(startsAt) + 1800_000).toISOString(), service: 'Consulta', encaixe: true });
    expect((await s.mgr.c.post('/api/appointments', body(s.pOther))).statusCode).toBe(404);
    expect((await s.mgr.c.post('/api/appointments', body(s.pOwn))).statusCode).toBe(200);
    expect((await s.mgr.c.post('/api/waitlist', { patientId: s.pOther, service: 'Consulta' })).statusCode).toBe(404);
  });

  it('pedidos do portal de paciente invisível não aparecem para o gerente', async () => {
    const s = await setup();
    await withTenant(appPool, s.t.id, (tx) => tx.query(`INSERT INTO portal_requests (tenant_id, patient_id, kind, message) VALUES ($1,$2,'schedule','quero marcar'), ($1,$3,'schedule','quero marcar também')`, [s.t.id, s.pOther, s.pOwn]));
    const mine = (await s.mgr.c.get('/api/portal-requests')).json().requests as { patientId: string }[];
    expect(mine.map((r) => r.patientId)).toEqual([s.pOwn]);
    expect(((await s.t.owner.get('/api/portal-requests')).json().requests as unknown[]).length).toBe(2);
  });
});

describe('escopo por unidade: estoque e CRM', () => {
  it('estoque: o gerente vê a unidade dele e o central (só consulta)', async () => {
    const s = await setup();
    const mk = async (name: string, unitId?: string) => (await s.t.owner.post('/api/inventory/items', { name, ...(unitId ? { unitId } : {}) })).json().id as string;
    const central = await mk('Luva central'), iA = await mk('Resina A', s.unitA), iB = await mk('Resina B', s.unitB);
    expect(ids(await s.mgr.c.get('/api/inventory/items'), 'items')).toEqual([central, iA].sort());
    expect(ids(await s.t.owner.get('/api/inventory/items'), 'items')).toHaveLength(3);
    const mov = (itemId: string) => s.mgr.c.post('/api/inventory/movements', { itemId, kind: 'in', quantity: 5 });
    expect((await mov(iA)).statusCode).toBe(200);
    expect((await mov(central)).statusCode).toBe(403);
    expect((await mov(iB)).statusCode).toBe(404);
    expect((await s.mgr.c.patch(`/api/inventory/items/${central}`, { name: 'Outro nome' })).statusCode).toBe(403);
    expect((await s.mgr.c.patch(`/api/inventory/items/${iB}`, { name: 'Outro nome' })).statusCode).toBe(404);
    expect((await s.mgr.c.patch(`/api/inventory/items/${iA}`, { name: 'Resina A2' })).statusCode).toBe(200);
    expect((await s.mgr.c.get(`/api/inventory/items/${central}/movements`)).statusCode).toBe(200);
    expect((await s.mgr.c.get(`/api/inventory/items/${iB}/movements`)).statusCode).toBe(404);
    expect((await s.mgr.c.get(`/api/inventory/items/${iB}/lots`)).statusCode).toBe(404);
    // criar: só na própria unidade
    expect((await s.mgr.c.post('/api/inventory/items', { name: 'Sem unidade' })).statusCode).toBe(403);
    expect((await s.mgr.c.post('/api/inventory/items', { name: 'Da outra', unitId: s.unitB })).statusCode).toBe(403);
    expect((await s.mgr.c.post('/api/inventory/items', { name: 'Da minha', unitId: s.unitA })).statusCode).toBe(200);
    expect((await s.t.owner.post('/api/inventory/items', { name: 'Unidade fantasma', unitId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(400);
  });

  it('CRM: o gerente vê só os leads da unidade e converte para pacientes que enxerga', async () => {
    const s = await setup();
    const lead = async (name: string, unitId?: string) => (await s.t.owner.post('/api/crm/leads', { name, phone: '11999990000', ...(unitId ? { unitId } : {}) })).json().id as string;
    const lA = await lead('Lead A', s.unitA), lB = await lead('Lead B', s.unitB), lN = await lead('Lead Sem Unidade');
    expect(ids(await s.mgr.c.get('/api/crm/leads'), 'leads')).toEqual([lA]);
    expect(ids(await s.t.owner.get('/api/crm/leads'), 'leads')).toHaveLength(3);
    expect((await s.mgr.c.get('/api/crm/leads')).json().counts.new).toBe(1);
    for (const l of [lB, lN]) {
      expect((await s.mgr.c.get(`/api/crm/leads/${l}`)).statusCode).toBe(404);
      expect((await s.mgr.c.patch(`/api/crm/leads/${l}`, { stage: 'contacted' })).statusCode).toBe(404);
      expect((await s.mgr.c.post(`/api/crm/leads/${l}/notes`, { note: 'oi' })).statusCode).toBe(404);
      expect((await s.mgr.c.post(`/api/crm/leads/${l}/convert`, {})).statusCode).toBe(404);
    }
    expect((await s.mgr.c.post('/api/crm/leads', { name: 'Sem unidade', phone: '1199' })).statusCode).toBe(403);
    expect((await s.mgr.c.post('/api/crm/leads', { name: 'Da outra', phone: '1199', unitId: s.unitB })).statusCode).toBe(403);
    expect((await s.mgr.c.post(`/api/crm/leads/${lA}/convert`, { patientId: s.pOther })).statusCode).toBe(404);
    const conv = await s.mgr.c.post(`/api/crm/leads/${lA}/convert`, {});
    expect(conv.statusCode).toBe(200);
    expect((await s.mgr.c.get(`/api/patients/${conv.json().patientId}`)).statusCode).toBe(200);          // criado por ele: visível
    // relatórios: gerente só recebe a parte de atendimentos
    const rep = (await s.mgr.c.get('/api/reports/overview?from=2032-01-01&to=2032-12-31')).json();
    expect(Object.keys(rep.sections)).toEqual(['appointments']);
  });
});

describe('política de escopo', () => {
  it('toda rota que o gerente de unidade alcança está classificada (deny-by-default)', () => {
    const reachable = routeRegistry.filter((r) => r.kind === 'clinic' && (!r.perm || hasPermission('unit_manager', r.perm)));
    expect(reachable.length).toBeGreaterThan(50);
    const missing = reachable.map((r) => `${r.method} ${r.url}`).filter((k) => !SCOPE_POLICY[k]);
    expect(missing).toEqual([]);
  });

  it('rota nova sem classificação é recusada ao gerente', async () => {
    const s = await setup();
    // /api/billing e /api/support-grants nem passam do RBAC; o importante é que nada fora da tabela passa
    expect((await s.mgr.c.get('/api/audit')).statusCode).toBe(403);
  });
});
