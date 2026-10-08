import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
type T = Awaited<ReturnType<typeof tenant>>;

/** Clínica com duas unidades (A e B), uma sala e um profissional em cada, e um gerente vinculado só à unidade A. */
async function setup(label: string) {
  const t = await tenant(label);
  const unitA = (await t.owner.post('/api/units', { name: 'Unidade A' })).json().id as string;
  const unitB = (await t.owner.post('/api/units', { name: 'Unidade B' })).json().id as string;
  const roomA = (await t.owner.post('/api/resources', { unitId: unitA, name: 'Sala A1', kind: 'room' })).json().id as string;
  const roomB = (await t.owner.post('/api/resources', { unitId: unitB, name: 'Sala B1', kind: 'room' })).json().id as string;
  const prA = await t.mk('professional', 'dra-a');
  const prB = await t.mk('professional', 'dr-b');
  const mgr = await t.mk('unit_manager', 'gerente-a');
  const users = (await t.owner.get('/api/users')).json().users as { id: string; email: string }[];
  const idOf = (e: string) => users.find((u) => u.email === e)!.id;
  const [idA, idB, idM] = [idOf(prA.email), idOf(prB.email), idOf(mgr.email)];
  expect((await t.owner.patch(`/api/users/${idA}`, { unitIds: [unitA] })).statusCode).toBe(200);
  expect((await t.owner.patch(`/api/users/${idB}`, { unitIds: [unitB] })).statusCode).toBe(200);
  expect((await t.owner.patch(`/api/users/${idM}`, { unitIds: [unitA] })).statusCode).toBe(200);
  const pid = (await t.owner.post('/api/patients', { name: 'Paciente Escopo' })).json().id as string;
  let h = 0;
  const book = async (c: T['owner'], professionalId: string, resourceId?: string) => {
    const startsAt = new Date(Date.UTC(2032, 2, 1, 9 + h++, 0)).toISOString();
    return c.post('/api/appointments', { patientId: pid, professionalId, resourceId, startsAt, endsAt: new Date(Date.parse(startsAt) + 1800_000).toISOString(), service: 'Consulta', encaixe: true });
  };
  return { t, unitA, unitB, roomA, roomB, idA, idB, idM, mgr, prA, pid, book };
}
const range = 'from=2032-02-28T00:00:00Z&to=2032-03-03T00:00:00Z';

describe('escopo por unidade do gerente', () => {
  it('vínculo: só gerente e profissional têm unidades; unidade inexistente é recusada; /api/me informa o escopo', async () => {
    const s = await setup('uscopelink');
    const rec = await s.t.mk('receptionist', 'rita');
    const recId = ((await s.t.owner.get('/api/users')).json().users as { id: string; email: string }[]).find((u) => u.email === rec.email)!.id;
    expect((await s.t.owner.patch(`/api/users/${recId}`, { unitIds: [s.unitA] })).statusCode).toBe(400);
    expect((await s.t.owner.patch(`/api/users/${s.idM}`, { unitIds: ['00000000-0000-4000-8000-000000000000'] })).statusCode).toBe(400);
    const users = (await s.t.owner.get('/api/users')).json().users as { id: string; unitIds: string[] }[];
    expect(users.find((u) => u.id === s.idM)!.unitIds).toEqual([s.unitA]);
    expect((await s.mgr.c.get('/api/me')).json().unitScope).toEqual([s.unitA]);
    expect((await s.t.owner.get('/api/me')).json().unitScope).toBeNull();
    // quem não é gerente nem profissional não pode alterar escopo de si mesmo (users.manage é de admin/dono)
    expect((await s.mgr.c.patch(`/api/users/${s.idM}`, { unitIds: [s.unitA, s.unitB] })).statusCode).toBe(403);
  });

  it('agenda: o gerente vê e altera só consultas das suas unidades (sala ou, sem sala, profissional)', async () => {
    const s = await setup('uscopeagenda');
    const a1 = (await s.book(s.t.owner, s.idA, s.roomA)).json().id as string;     // unidade A (sala)
    const a2 = (await s.book(s.t.owner, s.idB, s.roomB)).json().id as string;     // unidade B (sala)
    const a3 = (await s.book(s.t.owner, s.idA)).json().id as string;              // sem sala, profissional da A
    const a4 = (await s.book(s.t.owner, s.idB)).json().id as string;              // sem sala, profissional da B
    for (const id of [a1, a2, a3, a4]) expect(id).toBeTruthy();

    const all = ((await s.t.owner.get(`/api/appointments?${range}`)).json().appointments as { id: string }[]).map((x) => x.id).sort();
    expect(all).toEqual([a1, a2, a3, a4].sort());
    const mine = ((await s.mgr.c.get(`/api/appointments?${range}`)).json().appointments as { id: string }[]).map((x) => x.id).sort();
    expect(mine).toEqual([a1, a3].sort());
    const days = (await s.mgr.c.get(`/api/appointments/summary?${range}`)).json().days as { active: number }[];
    expect(days.reduce((a, d) => a + d.active, 0)).toBe(2);

    expect((await s.mgr.c.patch(`/api/appointments/${a2}`, { status: 'cancelled', reason: 'Tentativa fora da unidade' })).statusCode).toBe(404);
    expect((await s.mgr.c.patch(`/api/appointments/${a4}`, { status: 'confirmed' })).statusCode).toBe(404);
    expect((await s.mgr.c.patch(`/api/appointments/${a1}`, { status: 'confirmed' })).statusCode).toBe(200);

    // agendar fora da unidade é recusado; dentro, funciona
    expect((await s.book(s.mgr.c, s.idB, s.roomB)).statusCode).toBe(403);
    expect((await s.book(s.mgr.c, s.idB)).statusCode).toBe(403);
    expect((await s.book(s.mgr.c, s.idA, s.roomA)).statusCode).toBe(200);
    const serie = await s.mgr.c.post('/api/appointments/series', { patientId: s.pid, professionalId: s.idB, resourceId: s.roomB, startsAt: new Date(Date.UTC(2032, 4, 1, 9)).toISOString(), endsAt: new Date(Date.UTC(2032, 4, 1, 10)).toISOString(), service: 'Série', count: 2, encaixe: true });
    expect(serie.statusCode).toBe(403);

    // só os profissionais, salas e unidades dele
    expect(((await s.mgr.c.get('/api/professionals')).json().professionals as { id: string }[]).map((p) => p.id)).toEqual([s.idA]);
    expect(((await s.mgr.c.get('/api/resources')).json().resources as { id: string }[]).map((r) => r.id)).toEqual([s.roomA]);
    expect(((await s.mgr.c.get('/api/units')).json().units as { id: string }[]).map((u) => u.id)).toEqual([s.unitA]);
    expect(((await s.t.owner.get('/api/units')).json().units as unknown[]).length).toBe(2);
  });

  it('horários, bloqueios e lista de espera respeitam a unidade; bloqueio da clínica inteira não é do gerente', async () => {
    const s = await setup('uscopeblocks');
    const when = (d: number) => ({ startsAt: new Date(Date.UTC(2033, 0, d, 9)).toISOString(), endsAt: new Date(Date.UTC(2033, 0, d, 11)).toISOString() });
    const global = (await s.t.owner.post('/api/blocks', { ...when(2), reason: 'Feriado da clínica' })).json().id as string;
    const bA = (await s.t.owner.post('/api/blocks', { ...when(3), reason: 'Manutenção sala A', resourceId: s.roomA })).json().id as string;
    const bB = (await s.t.owner.post('/api/blocks', { ...when(4), reason: 'Manutenção sala B', resourceId: s.roomB })).json().id as string;
    const seen = ((await s.mgr.c.get('/api/blocks')).json().blocks as { id: string }[]).map((b) => b.id).sort();
    expect(seen).toEqual([global, bA].sort());
    expect(seen).not.toContain(bB);
    expect((await s.mgr.c.post('/api/blocks', { ...when(5), reason: 'Clínica toda' })).statusCode).toBe(403);
    expect((await s.mgr.c.post('/api/blocks', { ...when(5), reason: 'Sala de outra unidade', resourceId: s.roomB })).statusCode).toBe(403);
    expect((await s.mgr.c.post('/api/blocks', { ...when(5), reason: 'Profissional de outra unidade', professionalId: s.idB })).statusCode).toBe(403);
    expect((await s.mgr.c.post('/api/blocks', { ...when(5), reason: 'Sala da minha unidade', resourceId: s.roomA })).statusCode).toBe(200);
    expect((await s.mgr.c.del(`/api/blocks/${bB}`)).statusCode).toBe(404);
    expect((await s.mgr.c.del(`/api/blocks/${global}`)).statusCode).toBe(404);
    expect((await s.mgr.c.del(`/api/blocks/${bA}`)).statusCode).toBe(200);

    // horário de atendimento
    expect((await s.t.owner.post('/api/availability', { professionalId: s.idB, weekday: 1, start: '08:00', end: '12:00' })).statusCode).toBe(200);
    expect((await s.mgr.c.post('/api/availability', { professionalId: s.idB, weekday: 2, start: '08:00', end: '12:00' })).statusCode).toBe(403);
    expect((await s.mgr.c.post('/api/availability', { professionalId: s.idA, weekday: 2, start: '08:00', end: '12:00' })).statusCode).toBe(200);
    const rules = (await s.mgr.c.get('/api/availability')).json().rules as { professionalId: string }[];
    expect(rules.length).toBe(1);
    expect(rules[0]!.professionalId).toBe(s.idA);

    // lista de espera
    const wB = (await s.t.owner.post('/api/waitlist', { patientId: s.pid, professionalId: s.idB })).json().id as string;
    const wA = (await s.t.owner.post('/api/waitlist', { patientId: s.pid, professionalId: s.idA })).json().id as string;
    const wl = ((await s.mgr.c.get('/api/waitlist')).json().entries as { id: string }[]).map((e) => e.id);
    expect(wl).toEqual([wA]);
    expect((await s.mgr.c.patch(`/api/waitlist/${wB}`, { status: 'cancelled' })).statusCode).toBe(404);
    expect((await s.mgr.c.post('/api/waitlist', { patientId: s.pid, professionalId: s.idB })).statusCode).toBe(403);
  });

  it('indicadores: gerente vê só atendimentos das suas unidades; demais seções ficam indisponíveis; sem unidade vinculada não vê nada', async () => {
    const s = await setup('uscopereports');
    const slot = (h: number) => new Date(`${today()}T${String(h).padStart(2, '0')}:00:00-03:00`).toISOString();
    const mk = async (h: number, pro: string, room: string) => {
      const r = await s.t.owner.post('/api/appointments', { patientId: s.pid, professionalId: pro, resourceId: room, startsAt: slot(h), endsAt: slot(h + 1), service: 'Consulta', priceCents: 1000, encaixe: true });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().id as string;
    };
    const [x1, x2, x3] = [await mk(8, s.idA, s.roomA), await mk(10, s.idB, s.roomB), await mk(12, s.idB, s.roomB)];
    for (const id of [x1, x2, x3]) for (const status of ['checked_in', 'completed']) expect((await s.t.owner.patch(`/api/appointments/${id}`, { status })).statusCode).toBe(200);

    const q = `from=${today()}&to=${today()}`;
    const full = (await s.t.owner.get(`/api/reports/overview?${q}`)).json();
    expect(full.sections.appointments.total).toBe(3);
    const mine = (await s.mgr.c.get(`/api/reports/overview?${q}`)).json();
    expect(mine.sections.appointments.total).toBe(1);
    expect(Object.keys(mine.sections)).toEqual(['appointments']);
    expect((mine.omitted as { section: string }[]).map((o) => o.section).sort()).toEqual(['crm', 'finance', 'inventory', 'patients']);
    expect(JSON.stringify(mine)).not.toContain('dr-b');

    const dash = (await s.mgr.c.get('/api/dashboard')).json();
    expect(dash.appointmentsToday).toBe(1);
    expect((await s.t.owner.get('/api/dashboard')).json().appointmentsToday).toBe(3);

    // gerente sem unidade: nada (nega por padrão)
    expect((await s.t.owner.patch(`/api/users/${s.idM}`, { unitIds: [] })).statusCode).toBe(200);
    expect((await s.mgr.c.get(`/api/appointments?${range}`)).json().appointments).toEqual([]);
    expect((await s.mgr.c.get('/api/reception')).json().appointments).toEqual([]);
    expect((await s.mgr.c.get('/api/units')).json().units).toEqual([]);
    expect((await s.mgr.c.get(`/api/reports/overview?${q}`)).json().sections.appointments.total).toBe(0);
  });

  it('isolamento entre clínicas: vínculo com unidade de outra clínica é recusado', async () => {
    const a = await setup('uscopeisoa');
    const b = await setup('uscopeisob');
    expect((await b.t.owner.patch(`/api/users/${b.idM}`, { unitIds: [a.unitA] })).statusCode).toBe(400);
  });
});
