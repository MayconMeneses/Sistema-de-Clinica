import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

/** Instante no fuso de São Paulo (UTC−3). */
const at = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00-03:00`).toISOString();
const plus = (iso: string, min: number) => new Date(new Date(iso).getTime() + min * 60000).toISOString();
const weekdayOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const todaySp = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

async function clinic(plan = 'completa') {
  const t = await tenant('sch', plan);
  const dr = await t.mk('professional', 'dr');
  const dra = await t.mk('professional', 'dra');
  const rec = await t.mk('receptionist', 'rita');
  const adm = await t.mk('admin', 'ana');
  const pros = (await t.owner.get('/api/professionals')).json().professionals as { id: string; name: string }[];
  const [A, B] = [pros[0]!.id, pros[1]!.id];
  const patient = async (name: string, extra: object = {}) => (await t.owner.post('/api/patients', { name, ...extra })).json().id as string;
  const unit = (await t.owner.post('/api/units', { name: 'Unidade Centro' })).json().id as string;
  const room = async (name: string) => (await t.owner.post('/api/resources', { unitId: unit, name, kind: 'room' })).json().id as string;
  const book = (c: { post: (u: string, b: object) => Promise<{ statusCode: number; json: () => any }> }, b: object) => c.post('/api/appointments', { service: 'Consulta', ...b });
  return { t, dr, dra, rec, adm, A, B, patient, unit, room, book };
}

describe('salas e equipamentos', () => {
  it('a mesma sala não atende duas consultas ao mesmo tempo; outra sala ou sem sala pode', async () => {
    const c = await clinic();
    const s1 = await c.room('Sala 1'); const s2 = await c.room('Sala 2');
    const p1 = await c.patient('Paciente Um'); const p2 = await c.patient('Paciente Dois'); const p3 = await c.patient('Paciente Três');
    const start = at('2031-06-03', '10:00');
    expect((await c.book(c.t.owner, { patientId: p1, professionalId: c.A, resourceId: s1, startsAt: start, endsAt: plus(start, 60) })).statusCode).toBe(200);
    const clash = await c.book(c.t.owner, { patientId: p2, professionalId: c.B, resourceId: s1, startsAt: plus(start, 30), endsAt: plus(start, 90) });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().message).toMatch(/sala/i);
    expect((await c.book(c.t.owner, { patientId: p2, professionalId: c.B, resourceId: s2, startsAt: plus(start, 30), endsAt: plus(start, 90) })).statusCode).toBe(200);
    expect((await c.book(c.t.owner, { patientId: p3, professionalId: c.B, startsAt: plus(start, 120), endsAt: plus(start, 150) })).statusCode).toBe(200);
  });

  it('concorrência: duas reservas da mesma sala ao mesmo tempo → uma vence', async () => {
    const c = await clinic();
    const s1 = await c.room('Sala C');
    const p1 = await c.patient('Concorrente Um'); const p2 = await c.patient('Concorrente Dois');
    const start = at('2031-06-04', '09:00');
    const rs = await Promise.all([
      c.book(c.t.owner, { patientId: p1, professionalId: c.A, resourceId: s1, startsAt: start, endsAt: plus(start, 50) }),
      c.book(c.t.owner, { patientId: p2, professionalId: c.B, resourceId: s1, startsAt: start, endsAt: plus(start, 50) }),
    ]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('sala inexistente ou de outra clínica é recusada; só dono/admin cadastram unidades e salas', async () => {
    const a = await clinic(); const b = await clinic();
    const foreign = await b.room('Sala Alheia');
    const p = await a.patient('Paciente Sala');
    const start = at('2031-06-05', '09:00');
    expect((await a.book(a.t.owner, { patientId: p, professionalId: a.A, resourceId: foreign, startsAt: start, endsAt: plus(start, 30) })).statusCode).toBe(400);
    expect((await a.rec.c.post('/api/units', { name: 'Não pode' })).statusCode).toBe(403);
    expect((await a.dr.c.post('/api/resources', { unitId: a.unit, name: 'X', kind: 'room' })).statusCode).toBe(403);
    expect((await a.adm.c.post('/api/units', { name: 'Unidade Norte' })).statusCode).toBe(200);
    expect(((await b.t.owner.get('/api/units')).json().units as { name: string }[]).map((u) => u.name)).not.toContain('Unidade Norte');
  });
});

describe('horário de atendimento e encaixe', () => {
  const day = '2031-06-09'; // segunda-feira
  it('com horário cadastrado, fora dele só como encaixe, e só por perfil autorizado', async () => {
    const c = await clinic();
    const wd = weekdayOf(day);
    expect((await c.rec.c.post('/api/availability', { professionalId: c.A, weekday: wd, start: '08:00', end: '12:00' })).statusCode).toBe(200);
    const p = await c.patient('Paciente Horário');
    const mk = (t: string, dur = 30, extra: object = {}) => c.book(c.t.owner, { patientId: p, professionalId: c.A, startsAt: at(day, t), endsAt: plus(at(day, t), dur), ...extra });

    expect((await mk('09:00')).statusCode).toBe(200);
    const out = await mk('13:00');
    expect(out.statusCode).toBe(400);
    expect(out.json().error).toBe('outside_hours');
    expect(out.json().message).toMatch(/fora do horário/i);
    expect((await mk('11:45', 30)).statusCode).toBe(400);        // começa dentro e termina fora
    expect((await mk('08:00', 30, { priceCents: 0 })).statusCode).toBe(200);

    const nextDay = (await c.book(c.t.owner, { patientId: p, professionalId: c.A, startsAt: at('2031-06-10', '09:00'), endsAt: at('2031-06-10', '09:30') }));
    expect(nextDay.statusCode).toBe(400);                         // terça sem horário

    const p2 = await c.patient('Paciente Encaixe');
    const enc = await c.rec.c.post('/api/appointments', { patientId: p2, professionalId: c.A, startsAt: at(day, '13:00'), endsAt: at(day, '13:30'), encaixe: true });
    expect(enc.statusCode).toBe(200);
    const day0 = (await c.t.owner.get(`/api/appointments?from=${encodeURIComponent(at(day, '00:00'))}&to=${encodeURIComponent(at('2031-06-10', '00:00'))}`)).json().appointments as { patientId: string; outsideHours: boolean }[];
    expect(day0.find((x) => x.patientId === p2)!.outsideHours).toBe(true);
    expect(day0.find((x) => x.patientId === p)!.outsideHours).toBe(false);
    const pro = await c.dr.c.post('/api/appointments', { patientId: p2, professionalId: c.A, startsAt: at(day, '15:00'), endsAt: at(day, '15:30'), encaixe: true });
    expect(pro.statusCode).toBe(403);                             // profissional não faz encaixe
  });

  it('profissional sem horário cadastrado não tem restrição; horários não se sobrepõem; validações', async () => {
    const c = await clinic();
    const p = await c.patient('Paciente Livre');
    expect((await c.book(c.t.owner, { patientId: p, professionalId: c.B, startsAt: at(day, '22:00'), endsAt: at(day, '22:30') })).statusCode).toBe(200);
    const wd = weekdayOf(day);
    const add = (s: string, e: string) => c.t.owner.post('/api/availability', { professionalId: c.A, weekday: wd, start: s, end: e });
    expect((await add('08:00', '12:00')).statusCode).toBe(200);
    expect((await add('11:00', '13:00')).statusCode).toBe(409);
    expect((await add('12:00', '14:00')).statusCode).toBe(200);   // vizinho é permitido
    expect((await add('10:00', '09:00')).statusCode).toBe(400);
    expect((await add('8h', '9h')).statusCode).toBe(400);
    expect((await c.dr.c.post('/api/availability', { professionalId: c.A, weekday: wd, start: '15:00', end: '16:00' })).statusCode).toBe(403);
    const rules = (await c.t.owner.get('/api/availability')).json().rules as { id: string; start: string; end: string }[];
    expect(rules.map((r) => `${r.start}-${r.end}`)).toEqual(['08:00-12:00', '12:00-14:00']);
    expect((await c.t.owner.del(`/api/availability/${rules[0]!.id}`)).statusCode).toBe(200);
    expect((await c.t.owner.del(`/api/availability/${rules[0]!.id}`)).statusCode).toBe(404);
  });

  it('reagendar para fora do horário também exige encaixe', async () => {
    const c = await clinic();
    await c.rec.c.post('/api/availability', { professionalId: c.A, weekday: weekdayOf(day), start: '08:00', end: '12:00' });
    const p = await c.patient('Paciente Remarca');
    const id = (await c.book(c.t.owner, { patientId: p, professionalId: c.A, startsAt: at(day, '09:00'), endsAt: at(day, '09:30') })).json().id as string;
    const bad = await c.t.owner.patch(`/api/appointments/${id}`, { startsAt: at(day, '17:00'), endsAt: at(day, '17:30') });
    expect(bad.statusCode).toBe(400);
    expect((await c.t.owner.patch(`/api/appointments/${id}`, { startsAt: at(day, '10:00'), endsAt: at(day, '10:30') })).statusCode).toBe(200);
    expect((await c.rec.c.patch(`/api/appointments/${id}`, { startsAt: at(day, '17:00'), endsAt: at(day, '17:30'), encaixe: true })).statusCode).toBe(200);
  });
});

describe('bloqueios de agenda', () => {
  const day = '2031-06-16';
  it('bloqueio da clínica inteira, de um profissional e de uma sala', async () => {
    const c = await clinic();
    const s1 = await c.room('Sala B');
    const p = await c.patient('Paciente Bloqueio'); const p2 = await c.patient('Paciente Bloqueio 2');
    const book = (extra: object, t = '10:00') => c.book(c.t.owner, { patientId: p, startsAt: at(day, t), endsAt: plus(at(day, t), 30), ...extra });

    // profissional A bloqueado 14–16
    expect((await c.rec.c.post('/api/blocks', { startsAt: at(day, '14:00'), endsAt: at(day, '16:00'), professionalId: c.A, reason: 'Congresso' })).statusCode).toBe(200);
    const blocked = await book({ professionalId: c.A }, '14:30');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/bloqueado/i);
    expect((await book({ professionalId: c.B }, '14:30')).statusCode).toBe(200);   // outro profissional segue livre

    // sala bloqueada
    expect((await c.t.owner.post('/api/blocks', { startsAt: at(day, '08:00'), endsAt: at(day, '09:00'), resourceId: s1, reason: 'Manutenção do equipamento' })).statusCode).toBe(200);
    expect((await book({ professionalId: c.B, resourceId: s1 }, '08:30')).statusCode).toBe(409);
    expect((await c.book(c.t.owner, { patientId: p2, professionalId: c.B, startsAt: at(day, '08:30'), endsAt: at(day, '09:00') })).statusCode).toBe(200); // sem sala

    // clínica inteira (feriado)
    expect((await c.t.owner.post('/api/blocks', { startsAt: at('2031-06-17', '00:00'), endsAt: at('2031-06-18', '00:00'), reason: 'Feriado municipal' })).statusCode).toBe(200);
    for (const pro of [c.A, c.B]) expect((await c.book(c.t.owner, { patientId: p, professionalId: pro, startsAt: at('2031-06-17', '10:00'), endsAt: at('2031-06-17', '10:30') })).statusCode).toBe(409);
  });

  it('não bloqueia por cima de consulta marcada; remover o bloqueio libera o horário', async () => {
    const c = await clinic();
    const p = await c.patient('Paciente Marcado');
    const apptId = (await c.book(c.t.owner, { patientId: p, professionalId: c.A, startsAt: at(day, '11:00'), endsAt: at(day, '11:30') })).json().id as string;
    const over = await c.t.owner.post('/api/blocks', { startsAt: at(day, '10:00'), endsAt: at(day, '12:00'), professionalId: c.A, reason: 'Reunião' });
    expect(over.statusCode).toBe(409);
    expect(over.json().message).toMatch(/1 consulta/);
    await c.t.owner.patch(`/api/appointments/${apptId}`, { status: 'cancelled', reason: 'Remarcada pelo profissional' });
    const blk = await c.t.owner.post('/api/blocks', { startsAt: at(day, '10:00'), endsAt: at(day, '12:00'), professionalId: c.A, reason: 'Reunião' });
    expect(blk.statusCode).toBe(200);
    expect((await c.book(c.t.owner, { patientId: p, professionalId: c.A, startsAt: at(day, '11:00'), endsAt: at(day, '11:30') })).statusCode).toBe(409);
    expect((await c.t.owner.del(`/api/blocks/${blk.json().id}`)).statusCode).toBe(200);
    expect((await c.book(c.t.owner, { patientId: p, professionalId: c.A, startsAt: at(day, '11:00'), endsAt: at(day, '11:30') })).statusCode).toBe(200);
  });

  it('o BANCO recusa consulta sobre bloqueio, mesmo fora da API; reagendar para dentro do bloqueio falha', async () => {
    const c = await clinic();
    const p = await c.patient('Paciente Banco');
    await c.t.owner.post('/api/blocks', { startsAt: at(day, '18:00'), endsAt: at(day, '19:00'), professionalId: c.A, reason: 'Compromisso' });
    await expect(withTenant(appPool, c.t.id, (tx) => tx.query(
      `INSERT INTO appointments (tenant_id, patient_id, professional_id, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5)`,
      [c.t.id, p, c.A, at(day, '18:15'), at(day, '18:45')]))).rejects.toThrow(/bloqueado/);
    const id = (await c.book(c.t.owner, { patientId: p, professionalId: c.A, startsAt: at(day, '09:00'), endsAt: at(day, '09:30') })).json().id as string;
    expect((await c.t.owner.patch(`/api/appointments/${id}`, { startsAt: at(day, '18:00'), endsAt: at(day, '18:30') })).statusCode).toBe(409);
  });

  it('profissional não cria bloqueio; bloqueios de uma clínica não aparecem em outra', async () => {
    const a = await clinic(); const b = await clinic();
    expect((await a.dr.c.post('/api/blocks', { startsAt: at(day, '10:00'), endsAt: at(day, '11:00'), reason: 'Folga' })).statusCode).toBe(403);
    await a.t.owner.post('/api/blocks', { startsAt: at('2031-06-20', '10:00'), endsAt: at('2031-06-20', '11:00'), reason: 'Evento privado A' });
    expect(((await b.t.owner.get('/api/blocks')).json().blocks as unknown[]).length).toBe(0);
    expect((await a.t.owner.post('/api/blocks', { startsAt: at(day, '12:00'), endsAt: at(day, '11:00'), reason: 'Invertido' })).statusCode).toBe(400);
  });
});

describe('séries de consultas', () => {
  const start = at('2031-07-07', '10:00');
  const dayAfter = (n: number) => plus(start, n * 7 * 24 * 60);
  const listRange = async (c: Awaited<ReturnType<typeof clinic>>) =>
    (await c.t.owner.get(`/api/appointments?from=${encodeURIComponent(at('2031-07-01', '00:00'))}&to=${encodeURIComponent(at('2031-09-01', '00:00'))}`)).json().appointments as { patientId: string; seriesId: string | null; startsAt: string }[];

  it('conflito numa data: por padrão nada é criado (tudo-ou-nada) e a resposta aponta a data', async () => {
    const c = await clinic();
    const p = await c.patient('Paciente Série'); const other = await c.patient('Outro Paciente');
    await c.book(c.t.owner, { patientId: other, professionalId: c.A, startsAt: dayAfter(2), endsAt: plus(dayAfter(2), 50) });
    const r = await c.t.owner.post('/api/appointments/series', { patientId: p, professionalId: c.A, startsAt: start, endsAt: plus(start, 50), count: 4 });
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toMatch(/1 data/);
    expect((await listRange(c)).filter((x) => x.patientId === p)).toHaveLength(0);
  });

  it('com "pular conflitos": cria o que cabe, informa o resto e agrupa por série; mensagens: 1 confirmação + lembretes', async () => {
    const c = await clinic();
    const p = await c.patient('Paciente Série 2', { phone: '+5511988887777' });
    await c.t.owner.post(`/api/patients/${p}/consents`, { purpose: 'communication_whatsapp', granted: true });
    const other = await c.patient('Outro Paciente 2');
    await c.book(c.t.owner, { patientId: other, professionalId: c.A, startsAt: dayAfter(2), endsAt: plus(dayAfter(2), 50) });
    const r = await c.t.owner.post('/api/appointments/series', { patientId: p, professionalId: c.A, startsAt: start, endsAt: plus(start, 50), count: 4, skipConflicts: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ created: 3 });
    expect(r.json().conflicts).toHaveLength(1);
    expect(r.json().conflicts[0].reason).toMatch(/conflito/i);
    const mine = (await listRange(c)).filter((x) => x.patientId === p);
    expect(mine).toHaveLength(3);
    expect(new Set(mine.map((x) => x.seriesId)).size).toBe(1);
    expect(mine[0]!.seriesId).toBe(r.json().seriesId);
    const ev = (await workerPool.query(`SELECT payload->>'template' t FROM outbox_events WHERE tenant_id = $1 AND payload->>'patientId' = $2`, [c.t.id, p])).rows.map((x) => x.t as string);
    expect(ev.filter((t) => t === 'appointment_confirmation')).toHaveLength(1);
    expect(ev.filter((t) => t === 'appointment_reminder')).toHaveLength(3);
  });

  it('limites de repetição e perfis', async () => {
    const c = await clinic();
    const p = await c.patient('Paciente Limites');
    const body = (count: number) => ({ patientId: p, professionalId: c.A, startsAt: start, endsAt: plus(start, 30), count });
    expect((await c.t.owner.post('/api/appointments/series', body(1))).statusCode).toBe(400);
    expect((await c.t.owner.post('/api/appointments/series', body(27))).statusCode).toBe(400);
    expect((await c.t.owner.post('/api/appointments/series', body(3))).statusCode).toBe(200);
  });
});

describe('fila da recepção', () => {
  it('chegou → chamado → em atendimento → concluído; prioridade; cobrança única; transições inválidas', async () => {
    const c = await clinic();
    const day = todaySp();
    const [p1, p2, p3] = [await c.patient('Fila Um'), await c.patient('Fila Dois'), await c.patient('Fila Três')];
    const mk = async (patientId: string, t: string, price = 0) => (await c.book(c.t.owner, { patientId, professionalId: c.A, startsAt: at(day, t), endsAt: plus(at(day, t), 30), priceCents: price })).json().id as string;
    const a1 = await mk(p1, '09:00', 10000); const a2 = await mk(p2, '10:00'); const a3 = await mk(p3, '11:00');
    const st = (id: string, body: object, who = c.rec.c) => who.patch(`/api/appointments/${id}`, body);

    expect((await st(a1, { status: 'called' })).statusCode).toBe(409);           // precisa dar entrada antes
    expect((await st(a2, { status: 'checked_in' })).statusCode).toBe(200);
    expect((await st(a1, { status: 'checked_in', priority: 'priority' })).statusCode).toBe(200);

    let rec = (await c.rec.c.get('/api/reception')).json().appointments as { id: string; status: string; priority: string; checkedInAt: string | null }[];
    const byId = (id: string) => rec.find((x) => x.id === id)!;
    expect(byId(a1)).toMatchObject({ status: 'checked_in', priority: 'priority' });
    expect(byId(a1).checkedInAt).not.toBeNull();
    expect(byId(a2).priority).toBe('normal');
    expect(byId(a3).status).toBe('scheduled');
    const dash = (await c.t.owner.get('/api/dashboard')).json();
    expect(dash.waiting).toBe(2);

    expect((await st(a1, { status: 'called' })).statusCode).toBe(200);
    expect((await st(a1, { status: 'checked_in' })).statusCode).toBe(200);        // voltar para a fila
    expect((await st(a1, { status: 'called' })).statusCode).toBe(200);
    expect((await st(a1, { status: 'in_service' }, c.dr.c)).statusCode).toBe(200);
    expect((await st(a1, { status: 'completed' }, c.dr.c)).statusCode).toBe(200);
    expect((await st(a1, { status: 'called' })).statusCode).toBe(409);            // concluído é final
    expect((await st(a1, { status: 'completed' })).statusCode).toBe(409);
    expect((await st(a3, { status: 'no_show' })).statusCode).toBe(200);

    rec = (await c.rec.c.get('/api/reception')).json().appointments;
    expect(rec.map((x) => x.id).sort()).toEqual([a2].sort());                      // só quem segue ativo
    const fin = (await c.t.owner.get(`/api/patients/${p1}/finance`)).json();
    expect(fin.balanceCents).toBe('10000');
    expect((fin.movements as { kind: string }[]).filter((m) => m.kind === 'charge')).toHaveLength(1);

    const all = (await c.t.owner.get(`/api/appointments?from=${encodeURIComponent(at(day, '00:00'))}&to=${encodeURIComponent(plus(at(day, '00:00'), 1440))}`)).json().appointments as { id: string; calledAt: string | null; startedAt: string | null }[];
    const done = all.find((x) => x.id === a1)!;
    expect(done.calledAt).not.toBeNull();
    expect(done.startedAt).not.toBeNull();
  });

  it('financeiro não vê a fila; recepção vê; fila é isolada por clínica', async () => {
    const a = await clinic(); const b = await clinic();
    const fin = await a.t.mk('finance', 'fabio');
    expect((await fin.c.get('/api/reception')).statusCode).toBe(403);
    expect((await a.rec.c.get('/api/reception')).statusCode).toBe(200);
    expect(((await b.rec.c.get('/api/reception')).json().appointments as unknown[]).length).toBe(0);
  });
});

describe('lista de espera', () => {
  it('entra, ordena por prioridade, não duplica, resolve uma vez e é isolada', async () => {
    const a = await clinic(); const b = await clinic();
    const p1 = await a.patient('Espera Um'); const p2 = await a.patient('Espera Dois');
    const w1 = await a.rec.c.post('/api/waitlist', { patientId: p1, professionalId: a.A, notes: 'Prefere manhã' });
    expect(w1.statusCode).toBe(200);
    expect((await a.rec.c.post('/api/waitlist', { patientId: p1, professionalId: a.A })).statusCode).toBe(409);
    expect((await a.rec.c.post('/api/waitlist', { patientId: p2, priority: 'priority' })).statusCode).toBe(200);
    const list = (await a.rec.c.get('/api/waitlist')).json().entries as { patientName: string; priority: string }[];
    expect(list.map((x) => x.patientName)).toEqual(['Espera Dois', 'Espera Um']);   // prioridade primeiro
    expect((await a.rec.c.patch(`/api/waitlist/${w1.json().id}`, { status: 'scheduled' })).statusCode).toBe(200);
    expect((await a.rec.c.patch(`/api/waitlist/${w1.json().id}`, { status: 'cancelled' })).statusCode).toBe(404);
    expect(((await a.rec.c.get('/api/waitlist')).json().entries as unknown[]).length).toBe(1);
    expect((await b.rec.c.get('/api/waitlist')).json().entries).toHaveLength(0);
    expect((await b.rec.c.post('/api/waitlist', { patientId: p1 })).statusCode).toBe(400);  // paciente de outra clínica
  });
});
