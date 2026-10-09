import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant } from '../src/db/tenant.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { routeRegistry } = await import('../src/server/context.js');
const { Client, tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const pdf = Buffer.from('%PDF-1.4\nlaudo\n%%EOF').toString('base64');
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const ipOf = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
type T = Awaited<ReturnType<typeof tenant>>;

async function setup(plan = 'completa') {
  const t = await tenant('portal', plan);
  const dr = await t.mk('professional', 'drpt');
  const rec = await t.mk('receptionist', 'recpt');
  const proId = ((await t.owner.get('/api/professionals')).json().professionals as { id: string }[])[0]!.id;
  const patient = async (name: string, birth = '1990-05-17') => (await t.owner.post('/api/patients', { name, birthDate: birth })).json().id as string;
  const appt = async (patientId: string, startsAt: string, minutes = 30) =>
    (await t.owner.post('/api/appointments', { patientId, professionalId: proId, startsAt, endsAt: new Date(new Date(startsAt).getTime() + minutes * 60000).toISOString(), service: 'Consulta' })).json().id as string;
  const doc = async (patientId: string, category = 'other', title = 'Termo') =>
    (await t.owner.post(`/api/patients/${patientId}/documents`, { title, category, fileName: 'a.pdf', contentBase64: pdf })).json().id as string;
  return { t, dr, rec, proId, patient, appt, doc };
}

async function enter(t: T, patientId: string, birth = '1990-05-17', by: { post: (u: string, b?: unknown) => Promise<any> } = t.owner) {
  const inv = (await by.post(`/api/patients/${patientId}/portal-invite`)).json() as { link: string };
  const u = new URL(inv.link);
  const q = new URLSearchParams(u.hash.split('?')[1]);
  const c = new Client('ps');
  const r = await c.post('/api/portal/login', { clinic: q.get('clinic'), token: q.get('token'), birthDate: birth });
  return { c, r, clinic: q.get('clinic')!, token: q.get('token')! };
}

describe('portal do paciente: entrada', () => {
  it('convite de uso único + data de nascimento; erra 5 vezes e o convite trava; sessão só no caminho do portal', async () => {
    const s = await setup();
    const pid = await s.patient('Paciente Entrada');
    // quem pode convidar
    const fin = await s.t.mk('finance', 'finpt');
    expect((await fin.c.post(`/api/patients/${pid}/portal-invite`)).statusCode).toBe(403);
    const noBirth = (await s.t.owner.post('/api/patients', { name: 'Paciente Sem Nascimento' })).json().id as string;
    expect((await s.t.owner.post(`/api/patients/${noBirth}/portal-invite`)).statusCode).toBe(400);

    const inv = (await s.rec.c.post(`/api/patients/${pid}/portal-invite`)).json() as { link: string };
    expect(inv.link).toContain('/#/portal?clinic=');
    const q = new URLSearchParams(new URL(inv.link).hash.split('?')[1]);
    const login = (birthDate: string) => app.inject({ method: 'POST', url: '/api/portal/login', remoteAddress: ipOf(), headers: { 'x-requested-with': 'clinica-one' }, payload: { clinic: q.get('clinic'), token: q.get('token'), birthDate } });
    for (let i = 0; i < 5; i++) expect((await login('1991-01-01')).statusCode).toBe(401);
    expect((await login('1990-05-17')).statusCode).toBe(401);                    // travado: nem a data certa entra depois de 5 erros

    const fresh = await enter(s.t, pid);                                         // novo convite revoga o anterior
    expect(fresh.r.statusCode).toBe(200);
    const set = String(fresh.r.headers['set-cookie']);
    expect(set).toMatch(/^ps=/); expect(set).toMatch(/HttpOnly/i); expect(set).toMatch(/SameSite=Strict/i); expect(set).toMatch(/Path=\/api\/portal/);
    const again = await app.inject({ method: 'POST', url: '/api/portal/login', remoteAddress: ipOf(), headers: { 'x-requested-with': 'clinica-one' }, payload: { clinic: fresh.clinic, token: fresh.token, birthDate: '1990-05-17' } });
    expect(again.statusCode).toBe(401);                                          // uso único
    const msgs = new Set([(await login('1991-01-01')).json().message, again.json().message]);
    expect(msgs.size).toBe(1);                                                   // mesma mensagem para qualquer falha (sem enumerar)
    expect((await fresh.c.get('/api/portal/me')).statusCode).toBe(200);
  });

  it('as sessões não se misturam: paciente não entra na equipe, equipe não entra no portal; logout e revogação encerram', async () => {
    const s = await setup();
    const pid = await s.patient('Paciente Sessão');
    const { c } = await enter(s.t, pid);
    // o cookie do paciente não vale nas rotas da clínica
    const asStaff = new Client(); asStaff.cookie = c.cookie.replace(/^ps=/, 'cs=');
    expect((await asStaff.get('/api/me')).statusCode).toBe(401);
    expect((await c.get('/api/patients')).statusCode).toBe(401);
    // o cookie da equipe não vale no portal
    const asPatient = new Client('ps'); asPatient.cookie = s.t.owner.cookie.replace(/^cs=/, 'ps=');
    expect((await asPatient.get('/api/portal/me')).statusCode).toBe(401);
    // revogação pela clínica derruba a sessão na hora
    expect((await s.t.owner.post(`/api/patients/${pid}/portal-revoke`)).json().sessions).toBe(1);
    expect((await c.get('/api/portal/me')).statusCode).toBe(401);
    // logout
    const again = await enter(s.t, pid);
    const saved = again.c.cookie;
    expect((await again.c.post('/api/portal/logout')).statusCode).toBe(200);
    const stolen = new Client('ps'); stolen.cookie = saved;
    expect((await stolen.get('/api/portal/me')).statusCode).toBe(401);
  });

  it('clínica sem o recurso no plano não convida e o paciente não entra', async () => {
    const s = await setup('solo');
    const pid = await s.patient('Paciente Solo');
    expect((await s.t.owner.post(`/api/patients/${pid}/portal-invite`)).statusCode).toBe(403);
    const t2 = await setup();
    const p2 = await t2.patient('Paciente Plano Cheio');
    const inv = await enter(t2.t, p2);
    // convite de uma clínica não vale em outra
    const other = await app.inject({ method: 'POST', url: '/api/portal/login', remoteAddress: ipOf(), headers: { 'x-requested-with': 'clinica-one' }, payload: { clinic: s.t.slug, token: inv.token, birthDate: '1990-05-17' } });
    expect(other.statusCode).toBe(401);
  });
});

describe('portal do paciente: cada paciente vê só o que é seu (mesma clínica)', () => {
  it('consultas, documentos e pedidos de outro paciente nunca aparecem nem podem ser alterados', async () => {
    const s = await setup();
    const a = await s.patient('Paciente Alfa'); const b = await s.patient('Paciente Beta', '1985-02-02');
    const apA = await s.appt(a, inHours(72)); const apB = await s.appt(b, inHours(96));
    const dA = await s.doc(a, 'other', 'Termo Alfa'); const dB = await s.doc(b, 'other', 'Termo Beta');
    await s.t.owner.post(`/api/documents/${dA}/share`, { shared: true });
    await s.t.owner.post(`/api/documents/${dB}/share`, { shared: true });
    const A = await enter(s.t, a); const B = await enter(s.t, b, '1985-02-02');
    const meA = (await A.c.get('/api/portal/me')).json();
    expect(meA.upcoming.map((x: { id: string }) => x.id)).toEqual([apA]);
    expect(meA.documents.map((x: { id: string }) => x.id)).toEqual([dA]);
    expect(JSON.stringify(meA)).not.toContain('Beta');
    expect((await A.c.post(`/api/portal/appointments/${apB}/confirm`)).statusCode).toBe(404);
    expect((await A.c.post(`/api/portal/appointments/${apB}/cancel`, {})).statusCode).toBe(404);
    expect((await A.c.get(`/api/portal/documents/${dB}/download`)).statusCode).toBe(404);
    expect((await A.c.post('/api/portal/requests', { kind: 'reschedule', appointmentId: apB, message: 'Quero outro dia' })).statusCode).toBe(404);
    // a consulta de B continua intacta
    const stB = await withTenant(appPool, s.t.id, async (tx) => (await tx.query('SELECT status FROM appointments WHERE id = $1', [apB])).rows[0].status);
    expect(stB).toBe('scheduled');
    expect((await B.c.get('/api/portal/me')).json().upcoming.map((x: { id: string }) => x.id)).toEqual([apB]);
  });

  it('só baixa documento liberado e não arquivado; exame/laudo só a equipe clínica libera', async () => {
    const s = await setup();
    const a = await s.patient('Paciente Docs');
    const termo = await s.doc(a, 'consent', 'Termo');
    const exame = (await s.dr.c.post(`/api/patients/${a}/documents`, { title: 'Panorâmica', category: 'exam', fileName: 'p.pdf', contentBase64: pdf })).json().id as string;
    const A = await enter(s.t, a);
    expect((await A.c.get(`/api/portal/documents/${termo}/download`)).statusCode).toBe(404);          // ainda não liberado
    expect((await s.rec.c.post(`/api/documents/${termo}/share`, { shared: true })).statusCode).toBe(200);
    expect((await s.rec.c.post(`/api/documents/${exame}/share`, { shared: true })).statusCode).toBe(404); // recepção não libera exame
    expect((await s.dr.c.post(`/api/documents/${exame}/share`, { shared: true })).statusCode).toBe(200);
    const dl = await A.c.get(`/api/portal/documents/${termo}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect((await A.c.get(`/api/portal/documents/${exame}/download`)).statusCode).toBe(200);
    // descompartilhar e arquivar retiram o acesso
    await s.rec.c.post(`/api/documents/${termo}/share`, { shared: false });
    expect((await A.c.get(`/api/portal/documents/${termo}/download`)).statusCode).toBe(404);
    await s.dr.c.post(`/api/documents/${exame}/archive`, { reason: 'Enviado por engano' });
    expect((await A.c.get(`/api/portal/documents/${exame}/download`)).statusCode).toBe(404);
    const audit = await withTenant(appPool, s.t.id, async (tx) => (await tx.query(`SELECT action FROM audit_events WHERE action LIKE 'portal.%' ORDER BY occurred_at`)).rows.map((r) => r.action));
    expect(audit).toContain('portal.login'); expect(audit).toContain('portal.document_read');
  });
});

describe('portal do paciente: consultas e pedidos', () => {
  it('confirma; cancela na hora com 24 h ou mais; em cima da hora vira pedido que a recepção resolve', async () => {
    const s = await setup();
    const a = await s.patient('Paciente Consultas');
    const far = await s.appt(a, inHours(100)); const near = await s.appt(a, inHours(5)); const far2 = await s.appt(a, inHours(150));
    const A = await enter(s.t, a);
    const me = (await A.c.get('/api/portal/me')).json();
    const byId = Object.fromEntries(me.upcoming.map((x: { id: string }) => [x.id, x]));
    expect(byId[far].canCancelNow).toBe(true); expect(byId[near].canCancelNow).toBe(false);

    expect((await A.c.post(`/api/portal/appointments/${far}/confirm`)).json().status).toBe('confirmed');
    expect((await A.c.post(`/api/portal/appointments/${far}/confirm`)).statusCode).toBe(200);          // repetir não quebra
    expect((await A.c.post(`/api/portal/appointments/${far}/cancel`, { reason: 'Viagem' })).json().status).toBe('cancelled');
    expect((await A.c.post(`/api/portal/appointments/${far}/cancel`, {})).statusCode).toBe(409);        // já cancelada
    expect((await A.c.post(`/api/portal/appointments/${far}/confirm`)).statusCode).toBe(409);

    const req = await A.c.post(`/api/portal/appointments/${near}/cancel`, { reason: 'Imprevisto' });
    expect(req.json().status).toBe('requested');
    expect((await A.c.post(`/api/portal/appointments/${near}/cancel`, {})).statusCode).toBe(409);       // pedido já aberto
    const st = await withTenant(appPool, s.t.id, async (tx) => (await tx.query('SELECT status FROM appointments WHERE id = $1', [near])).rows[0].status);
    expect(st).toBe('scheduled');                                                                       // ainda não cancelou: a clínica decide

    const open = (await s.rec.c.get('/api/portal-requests')).json().requests as { id: string; kind: string; patientName: string }[];
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'cancel', patientName: 'Paciente Consultas' });
    const fin = await s.t.mk('finance', 'finreq');
    expect((await fin.c.get('/api/portal-requests')).statusCode).toBe(403);
    expect((await s.rec.c.post(`/api/portal-requests/${open[0]!.id}/resolve`, { action: 'done' })).statusCode).toBe(200);
    expect((await s.rec.c.post(`/api/portal-requests/${open[0]!.id}/resolve`, { action: 'done' })).statusCode).toBe(409);
    const after = await withTenant(appPool, s.t.id, async (tx) => (await tx.query('SELECT status, cancel_reason FROM appointments WHERE id = $1', [near])).rows[0]);
    expect(after.status).toBe('cancelled'); expect(after.cancel_reason).toMatch(/portal/);
    expect(far2).toBeTruthy();
  });

  it('pedido de novo horário e de remarcação: limites, duplicidade e validação', async () => {
    const s = await setup();
    const a = await s.patient('Paciente Pedidos');
    const ap = await s.appt(a, inHours(200));
    const A = await enter(s.t, a);
    expect((await A.c.post('/api/portal/requests', { kind: 'schedule', message: 'ab' })).statusCode).toBe(400);           // curto demais
    expect((await A.c.post('/api/portal/requests', { kind: 'reschedule', message: 'Quero outro dia' })).statusCode).toBe(400); // falta a consulta
    expect((await A.c.post('/api/portal/requests', { kind: 'cancel', message: 'Quero cancelar' })).statusCode).toBe(400);     // cancelar tem rota própria
    for (let i = 0; i < 3; i++) expect((await A.c.post('/api/portal/requests', { kind: 'schedule', message: `Prefiro terça de manhã (${i})` })).statusCode).toBe(200);
    expect((await A.c.post('/api/portal/requests', { kind: 'schedule', message: 'Mais um pedido' })).statusCode).toBe(409);   // máximo de 3 em aberto
    expect((await A.c.post('/api/portal/requests', { kind: 'reschedule', appointmentId: ap, message: 'Prefiro sexta à tarde' })).statusCode).toBe(200);
    expect((await A.c.post('/api/portal/requests', { kind: 'reschedule', appointmentId: ap, message: 'Prefiro sexta à tarde' })).statusCode).toBe(409);
    expect((await s.rec.c.get('/api/portal-requests')).json().requests).toHaveLength(4);
    const meReqs = (await A.c.get('/api/portal/me')).json().requests as unknown[];
    expect(meReqs.length).toBe(4);
  });
});

describe('portal do paciente: varredura de rotas com a sessão de outro paciente e de outra clínica', () => {
  it('nenhuma rota do portal entrega ou altera objetos de quem não é o dono da sessão; entradas hostis não dão 5xx', async () => {
    const s = await setup(); const other = await setup();
    const a = await s.patient('Paciente Dono MARCA-A'); const b = await s.patient('Paciente Intruso', '1985-02-02');
    const apA = await s.appt(a, inHours(120)); const dA = await s.doc(a, 'other', 'Termo MARCA-A');
    await s.t.owner.post(`/api/documents/${dA}/share`, { shared: true });
    const o = await other.patient('Paciente Outra Clínica', '1980-03-03');
    const B = await enter(s.t, b, '1985-02-02');                    // paciente da mesma clínica
    const O = await enter(other.t, o, '1980-03-03');                // paciente de outra clínica
    const ids = [apA, dA, a, randomUUID(), 'not-a-uuid', '../../x', '\u0000'];
    const bad: string[] = [];
    for (const who of [B, O]) {
      for (const r of routeRegistry.filter((x) => x.kind === 'portal')) {
        for (const id of /:[A-Za-z]+/.test(r.url) ? ids : [randomUUID()]) {
          const url = r.url.replace(/:[A-Za-z]+/g, encodeURIComponent(id));
          if (url.endsWith('/logout')) continue;
          const res = await who.c.req(r.method as 'GET', url, r.method === 'GET' ? undefined : { kind: 'schedule', message: 'MARCA-A', reason: '\u0000' });
          if (res.statusCode >= 500) bad.push(`5xx ${r.method} ${r.url} ${id}`);
          if (res.body.includes('MARCA-A') && r.method === 'GET') bad.push(`vazou ${r.method} ${r.url}`);
          if (res.statusCode < 300 && /appointments|documents/.test(r.url) && r.method === 'POST') bad.push(`2xx em objeto alheio ${r.url} ${id}`);
        }
      }
    }
    expect(bad).toEqual([]);
    const stillA = await withTenant(appPool, s.t.id, async (tx) => (await tx.query('SELECT status FROM appointments WHERE id = $1', [apA])).rows[0].status);
    expect(stillA).toBe('scheduled');
  });
});
