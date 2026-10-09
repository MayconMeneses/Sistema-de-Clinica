import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { daySlots } from '../src/modules/booking/slots.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { Client, tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

describe('horários livres (regra pura)', () => {
  const now = new Date('2032-03-01T12:00:00Z');                    // 09:00 em São Paulo
  const base = { ymd: '2032-03-03', rules: [{ start_min: 480, end_min: 600 }], slotMinutes: 30, now, minNoticeHours: 12, maxDaysAhead: 30, busy: [] as { start: Date; end: Date }[] };
  const hhmm = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(11, 16);
  it('gera os horários da janela no fuso de São Paulo, só os que cabem inteiros', () => {
    expect(daySlots(base).map(hhmm)).toEqual(['08:00', '08:30', '09:00', '09:30']);
    expect(daySlots({ ...base, rules: [{ start_min: 480, end_min: 590 }] }).map(hhmm)).toEqual(['08:00', '08:30', '09:00']);   // 09:30–10:00 não cabe
  });
  it('respeita ocupados, antecedência mínima e horizonte', () => {
    const busy = [{ start: new Date('2032-03-03T11:30:00Z'), end: new Date('2032-03-03T12:30:00Z') }];       // 08:30–09:30
    expect(daySlots({ ...base, busy }).map(hhmm)).toEqual(['08:00', '09:30']);
    expect(daySlots({ ...base, now: new Date('2032-03-03T10:00:00Z') }).map(hhmm)).toEqual([]);                // 07:00 local + 12 h: tudo dentro da antecedência
    expect(daySlots({ ...base, ymd: '2032-04-30' })).toEqual([]);                                                // além do horizonte
  });
});

async function setup() {
  const t = await tenant('pbook');
  const pro = await t.mk('professional', 'drbk');
  const pro2 = await t.mk('professional', 'drbk2');
  const rec = await t.mk('receptionist', 'recbk');
  const fin = await t.mk('finance', 'finbk');
  const users = (await t.owner.get('/api/users')).json().users as { id: string; email: string }[];
  const proId = users.find((u) => u.email === pro.email)!.id, pro2Id = users.find((u) => u.email === pro2.email)!.id;
  for (const id of [proId, pro2Id]) for (let w = 0; w < 7; w++) expect((await t.owner.post('/api/availability', { professionalId: id, weekday: w, start: '08:00', end: '12:00' })).statusCode).toBe(200);
  const patient = async (name: string, birth: string) => (await t.owner.post('/api/patients', { name, birthDate: birth, confirmNotDuplicate: true })).json().id as string;
  const enter = async (pid: string, birth: string) => {
    const inv = (await t.owner.post(`/api/patients/${pid}/portal-invite`)).json() as { link: string };
    const q = new URLSearchParams(new URL(inv.link).hash.split('?')[1]);
    const c = new Client('ps');
    expect((await c.post('/api/portal/login', { clinic: q.get('clinic'), token: q.get('token'), birthDate: birth })).statusCode).toBe(200);
    return c;
  };
  const config = (over: object = {}) => t.owner.req('PUT', '/api/portal-booking', { enabled: true, slotMinutes: 30, minNoticeHours: 12, maxDaysAhead: 30, maxActivePerPatient: 2, service: 'Consulta online', professionalIds: [proId], ...over });
  return { t, rec, fin, proId, pro2Id, patient, enter, config };
}

describe('autoagendamento pelo portal', () => {
  it('desligado por padrão; ligar libera só os profissionais escolhidos; paciente marca um horário livre', async () => {
    const s = await setup();
    const pid = await s.patient('Paciente Marca Sozinho', '1990-05-17');
    const c = await s.enter(pid, '1990-05-17');
    expect((await c.get('/api/portal/booking')).statusCode).toBe(403);
    expect((await c.get('/api/portal/me')).json().bookingEnabled).toBe(false);

    expect((await s.config({ professionalIds: [] })).statusCode).toBe(400);                  // ligar sem profissional
    expect((await s.config()).statusCode).toBe(200);
    expect((await c.get('/api/portal/me')).json().bookingEnabled).toBe(true);
    const opts = (await c.get('/api/portal/booking')).json();
    expect(opts.professionals.map((p: { id: string }) => p.id)).toEqual([s.proId]);           // pro2 não foi liberado
    expect(opts.remaining).toBe(2);

    const day = new Date(Date.parse(`${opts.today}T12:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10);
    const slots = (await c.get(`/api/portal/booking/slots?professionalId=${s.proId}&date=${day}`)).json().slots as string[];
    expect(slots).toHaveLength(8);                                                            // 08:00–12:00, de 30 em 30
    expect((await c.get(`/api/portal/booking/slots?professionalId=${s.pro2Id}&date=${day}`)).statusCode).toBe(404);
    expect((await c.get(`/api/portal/booking/slots?professionalId=${s.proId}&date=2020-01-01`)).json().slots).toEqual([]);
    expect((await c.get(`/api/portal/booking/slots?professionalId=${s.proId}&date=2032-13-45`)).statusCode).toBe(400);

    // só horário que o servidor ofereceu; horário inventado é recusado
    const odd = new Date(Date.parse(slots[0]!) + 7 * 60_000).toISOString();
    expect((await c.post('/api/portal/booking', { professionalId: s.proId, startsAt: odd })).statusCode).toBe(409);
    expect((await c.post('/api/portal/booking', { professionalId: s.pro2Id, startsAt: slots[0] })).statusCode).toBe(404);
    const ok = await c.post('/api/portal/booking', { professionalId: s.proId, startsAt: slots[0] });
    expect(ok.statusCode).toBe(200);

    // vira consulta normal na agenda, marcada como vinda do portal; o horário sai da lista; aparece nas consultas do paciente
    const row = await withTenant(appPool, s.t.id, (tx) => tx.query('SELECT status, service, booked_via, created_by FROM appointments WHERE id = $1', [ok.json().id]));
    expect(row.rows[0]).toMatchObject({ status: 'scheduled', service: 'Consulta online', booked_via: 'portal', created_by: null });
    const after = (await c.get(`/api/portal/booking/slots?professionalId=${s.proId}&date=${day}`)).json().slots as string[];
    expect(after).toHaveLength(7);
    expect(after).not.toContain(slots[0]);
    expect(((await c.get('/api/portal/me')).json().upcoming as { id: string }[]).map((a) => a.id)).toContain(ok.json().id);
    const audit = await withTenant(appPool, s.t.id, (tx) => tx.query(`SELECT metadata FROM audit_events WHERE action = 'portal.appointment_booked'`));
    expect(audit.rows[0].metadata.via).toBe('portal');
  });

  it('dois pacientes disputando o mesmo horário: só um leva; limite por paciente; cancelar libera', async () => {
    const s = await setup();
    expect((await s.config({ maxActivePerPatient: 2 })).statusCode).toBe(200);
    const [p1, p2] = [await s.patient('Disputa Um', '1991-01-01'), await s.patient('Disputa Dois', '1992-02-02')];
    const [c1, c2] = [await s.enter(p1, '1991-01-01'), await s.enter(p2, '1992-02-02')];
    const today = (await c1.get('/api/portal/booking')).json().today as string;
    const dayN = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const slotsOf = async (c: InstanceType<typeof Client>, n: number) => (await c.get(`/api/portal/booking/slots?professionalId=${s.proId}&date=${dayN(n)}`)).json().slots as string[];
    const target = (await slotsOf(c1, 3))[2]!;
    const [r1, r2] = await Promise.all([c1.post('/api/portal/booking', { professionalId: s.proId, startsAt: target }), c2.post('/api/portal/booking', { professionalId: s.proId, startsAt: target })]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);

    // limite de 2 marcações abertas por paciente
    const winner = r1.statusCode === 200 ? c1 : c2;
    const b2 = await winner.post('/api/portal/booking', { professionalId: s.proId, startsAt: (await slotsOf(winner, 4))[0] });
    expect(b2.statusCode).toBe(200);
    const b3 = await winner.post('/api/portal/booking', { professionalId: s.proId, startsAt: (await slotsOf(winner, 5))[0] });
    expect(b3.statusCode).toBe(409);
    expect((await winner.get('/api/portal/booking')).json().remaining).toBe(0);

    // o próprio paciente não consegue marcar sobre outra consulta dele; cancelar (24 h ou mais) devolve o horário e a vaga
    const mine = ((await winner.get('/api/portal/me')).json().upcoming as { id: string }[])[0]!.id;
    expect((await winner.post(`/api/portal/appointments/${mine}/cancel`, {})).statusCode).toBe(200);
    expect((await winner.get('/api/portal/booking')).json().remaining).toBe(1);
    expect((await slotsOf(winner, 3))).toContain(target);
  });

  it('bloqueios da agenda, antecedência mínima e profissional sem horário tiram as opções', async () => {
    const s = await setup();
    expect((await s.config()).statusCode).toBe(200);
    const pid = await s.patient('Bloqueio Teste', '1990-03-03');
    const c = await s.enter(pid, '1990-03-03');
    const today = (await c.get('/api/portal/booking')).json().today as string;
    const day = new Date(Date.parse(`${today}T12:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10);
    const url = `/api/portal/booking/slots?professionalId=${s.proId}&date=${day}`;
    expect(((await c.get(url)).json().slots as string[]).length).toBe(8);
    // feriado da clínica inteira
    expect((await s.t.owner.post('/api/blocks', { startsAt: `${day}T00:00:00-03:00`, endsAt: `${day}T23:59:00-03:00`, reason: 'Feriado de teste' })).statusCode).toBe(200);
    expect((await c.get(url)).json().slots).toEqual([]);
    // antecedência de 200 h: nada nos próximos 8 dias
    expect((await s.config({ minNoticeHours: 168 })).statusCode).toBe(200);
    const d2 = new Date(Date.parse(`${today}T12:00:00Z`) + 4 * 86400000).toISOString().slice(0, 10);
    expect((await c.get(`/api/portal/booking/slots?professionalId=${s.proId}&date=${d2}`)).json().slots).toEqual([]);
    // sem horário de atendimento cadastrado, o profissional some da lista
    const rules = (await s.t.owner.get('/api/availability')).json().rules as { id: string; professionalId: string }[];
    for (const r of rules.filter((x) => x.professionalId === s.proId)) await s.t.owner.del(`/api/availability/${r.id}`);
    expect((await c.get('/api/portal/booking')).json().professionals).toEqual([]);
  });

  it('configuração: só quem gerencia o portal; plano sem portal e outras clínicas ficam de fora', async () => {
    const s = await setup();
    expect((await s.rec.c.req('PUT', '/api/portal-booking', { enabled: false, slotMinutes: 30, minNoticeHours: 12, maxDaysAhead: 30, maxActivePerPatient: 2, service: 'Consulta', professionalIds: [] })).statusCode).toBe(200);
    expect((await s.fin.c.get('/api/portal-booking')).statusCode).toBe(403);
    const bad = (o: object) => s.t.owner.req('PUT', '/api/portal-booking', { enabled: false, slotMinutes: 30, minNoticeHours: 12, maxDaysAhead: 30, maxActivePerPatient: 2, service: 'Consulta', professionalIds: [], ...o });
    for (const o of [{ slotMinutes: 5 }, { slotMinutes: 500 }, { minNoticeHours: -1 }, { maxDaysAhead: 0 }, { maxActivePerPatient: 99 }, { service: 'x' }, { professionalIds: ['nao-uuid'] }, { professionalIds: [s.rec.email] }, { extra: 1 }]) expect((await bad(o)).statusCode, JSON.stringify(o)).toBe(400);
    // profissional de outra clínica / usuário que não é profissional
    const other = await setup();
    expect((await bad({ professionalIds: [other.proId] })).statusCode).toBe(400);
    const users = (await s.t.owner.get('/api/users')).json().users as { id: string; role: string }[];
    expect((await bad({ professionalIds: [users.find((u) => u.role === 'receptionist')!.id] })).statusCode).toBe(400);
    // paciente de uma clínica não marca na outra
    expect((await other.config()).statusCode).toBe(200);
    const pid = await s.patient('Outro Mundo', '1990-01-01');
    const c = await s.enter(pid, '1990-01-01');
    expect((await c.get('/api/portal/booking')).statusCode).toBe(403);                         // a clínica dele não ligou
    const solo = await tenant('pbook-solo', 'solo');
    expect((await solo.owner.get('/api/portal-booking')).statusCode).toBe(403);
  });
});
