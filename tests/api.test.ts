import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/server/auth/password.js';
import { generateSecret, totpAt } from '../src/server/auth/totp.js';

process.env.DATABASE_URL_APP ??= 'postgres://clinica_app:dev_app_pw@127.0.0.1:5432/clinica_one';
process.env.DATABASE_URL_PLATFORM ??= 'postgres://clinica_platform:dev_platform_pw@127.0.0.1:5432/clinica_one';
const { buildApp } = await import('../src/server/app.js');
const { platformPool } = await import('../src/server/db.js');

const PW = 'Senha-Teste-123';
let app: FastifyInstance;

class Client {
  cookie = '';
  constructor(private prefix = '') {}
  async req(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const res = await app.inject({
      method, url, payload: payload as object | undefined,
      headers: { 'x-requested-with': 'clinica-one', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    const set = res.cookies.find((c) => c.name === (this.prefix || 'cs'));
    if (set) this.cookie = set.value ? `${set.name}=${set.value}` : '';
    return res;
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b?: unknown) => this.req('POST', u, b ?? {});
  patch = (u: string, b: unknown) => this.req('PATCH', u, b);
}

async function tenant(label: string, plan = 'completa') {
  const slug = `api-${label}-${randomUUID().slice(0, 6)}`;
  const id = randomUUID();
  await platformPool.query("INSERT INTO tenants (id, slug, name, plan_code, status) VALUES ($1,$2,$3,$4,'active')", [id, slug, `Clínica ${label}`, plan]);
  await platformPool.query("INSERT INTO users (id, tenant_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5,'owner')", [randomUUID(), id, `dono@${slug}.test`, 'Dono', await hashPassword(PW)]);
  const owner = new Client();
  expect((await owner.post('/api/auth/login', { clinic: slug, email: `dono@${slug}.test`, password: PW })).statusCode).toBe(200);
  const mk = async (role: string, name: string) => {
    const email = `${role}-${name}@${slug}.test`;
    expect((await owner.post('/api/users', { name, email, role, password: PW })).statusCode).toBe(200);
    const c = new Client();
    expect((await c.post('/api/auth/login', { clinic: slug, email, password: PW })).statusCode).toBe(200);
    return { c, email };
  };
  return { id, slug, owner, mk };
}

async function master() {
  const email = `m-${randomUUID().slice(0, 6)}@master.test`;
  const secret = generateSecret();
  await platformPool.query('INSERT INTO platform_users (email, name, password_hash, totp_secret) VALUES ($1,$2,$3,$4)', [email, 'Op', await hashPassword(PW), secret]);
  const c = new Client('ms');
  const r = await c.post('/api/master/login', { email, password: PW, code: totpAt(secret, Date.now()) });
  expect(r.statusCode).toBe(200);
  return { c, email, secret, code: () => totpAt(secret, Date.now()) };
}

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });

describe('autenticação da clínica', () => {
  it('login emite cookie HttpOnly SameSite=Strict e /api/me responde', async () => {
    const t = await tenant('auth');
    const res = await new Client().post('/api/auth/login', { clinic: t.slug, email: `dono@${t.slug}.test`, password: PW });
    const cookie = res.cookies.find((c) => c.name === 'cs')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    const me = await t.owner.get('/api/me');
    expect(me.json().user.role).toBe('owner');
    expect(me.json().entitlements).toContain('clinical.record');
  });

  it('credencial errada, e-mail inexistente e clínica inexistente dão a mesma resposta genérica', async () => {
    const t = await tenant('generic');
    const a = await new Client().post('/api/auth/login', { clinic: t.slug, email: `dono@${t.slug}.test`, password: 'errada-errada' });
    const b = await new Client().post('/api/auth/login', { clinic: t.slug, email: 'nao@existe.test', password: PW });
    const c = await new Client().post('/api/auth/login', { clinic: 'nao-existe-xyz', email: 'a@b.co', password: PW });
    for (const r of [a, b, c]) { expect(r.statusCode).toBe(401); expect(r.json().message).toBe('Clínica, e-mail ou senha inválidos.'); }
  });

  it('bloqueia login após 5 falhas (rate limit)', async () => {
    const t = await tenant('rl');
    const cli = new Client();
    for (let i = 0; i < 5; i++) await cli.post('/api/auth/login', { clinic: t.slug, email: `dono@${t.slug}.test`, password: 'errada-errada' });
    const r = await cli.post('/api/auth/login', { clinic: t.slug, email: `dono@${t.slug}.test`, password: PW });
    expect(r.statusCode).toBe(429);
  });

  it('exige cabeçalho anti-CSRF nas mutações e rejeita sem sessão', async () => {
    const t = await tenant('csrf');
    const noHeader = await app.inject({ method: 'POST', url: '/api/patients', payload: { name: 'X Y' }, headers: { cookie: t.owner.cookie } });
    expect(noHeader.statusCode).toBe(403);
    const noSession = await new Client().post('/api/patients', { name: 'Fulano' });
    expect(noSession.statusCode).toBe(401);
    const evilOrigin = await t.owner.req('POST', '/api/patients', { name: 'Fulano' }, { origin: 'https://evil.example', host: 'app.local' });
    expect(evilOrigin.statusCode).toBe(403);
  });

  it('respostas de erro não vazam stack nem SQL', async () => {
    const t = await tenant('leak');
    const r = await t.owner.get('/api/patients/not-a-uuid');
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toMatch(/stack|SELECT|node_modules|at .*\(/i);
  });

  it('usuário suspenso perde a sessão antiga imediatamente', async () => {
    const t = await tenant('susp');
    const rec = await t.mk('receptionist', 'rita');
    expect((await rec.c.get('/api/patients')).statusCode).toBe(200);
    const users = (await t.owner.get('/api/users')).json().users as { id: string; email: string }[];
    const id = users.find((u) => u.email === rec.email)!.id;
    expect((await t.owner.patch(`/api/users/${id}`, { status: 'suspended' })).statusCode).toBe(200);
    expect((await rec.c.get('/api/patients')).statusCode).toBe(401);
    expect((await new Client().post('/api/auth/login', { clinic: t.slug, email: rec.email, password: PW })).statusCode).toBe(401);
  });

  it('troca de senha revoga as demais sessões', async () => {
    const t = await tenant('pw');
    const other = new Client();
    await other.post('/api/auth/login', { clinic: t.slug, email: `dono@${t.slug}.test`, password: PW });
    expect((await other.get('/api/me')).statusCode).toBe(200);
    expect((await t.owner.post('/api/me/password', { current: PW, next: 'Outra-Senha-456' })).statusCode).toBe(200);
    expect((await other.get('/api/me')).statusCode).toBe(401);
    expect((await t.owner.get('/api/me')).statusCode).toBe(200); // sessão atual renovada
  });

  it('logout revoga a sessão no servidor (cookie reutilizado não funciona)', async () => {
    const t = await tenant('logout');
    const saved = t.owner.cookie;
    await t.owner.post('/api/auth/logout');
    const replay = new Client(); replay.cookie = saved;
    expect((await replay.get('/api/me')).statusCode).toBe(401);
  });
});

describe('isolamento entre clínicas via HTTP', () => {
  it('clínica B não lê, altera nem lista pacientes da A', async () => {
    const a = await tenant('isoa'); const b = await tenant('isob');
    const created = await a.owner.post('/api/patients', { name: 'Paciente da A' });
    const pid = created.json().id as string;
    expect((await b.owner.get(`/api/patients/${pid}`)).statusCode).toBe(404);
    expect((await b.owner.patch(`/api/patients/${pid}`, { name: 'Invadido' })).statusCode).toBe(404);
    expect((await b.owner.get('/api/patients')).json().patients).toHaveLength(0);
    expect((await a.owner.get(`/api/patients/${pid}`)).json().patient.name).toBe('Paciente da A');
  });

  it('cookie forjado com tenant de A e segredo de B é rejeitado', async () => {
    const a = await tenant('forgea'); const b = await tenant('forgeb');
    const secretB = b.owner.cookie.split('=')[1]!.split('.')[1]!;
    const forged = new Client(); forged.cookie = `cs=${a.id}.${secretB}`;
    expect((await forged.get('/api/me')).statusCode).toBe(401);
  });

  it('não agenda paciente de outra clínica (FK composta)', async () => {
    const a = await tenant('fka'); const b = await tenant('fkb');
    const pid = (await a.owner.post('/api/patients', { name: 'Paciente A' })).json().id;
    const pro = await b.mk('professional', 'dr');
    const proId = ((await b.owner.get('/api/professionals')).json().professionals as { id: string }[])[0]!.id;
    const r = await b.owner.post('/api/appointments', { patientId: pid, professionalId: proId, startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' });
    expect(r.statusCode).toBe(400);
    void pro;
  });
});

describe('RBAC e entitlements', () => {
  it('recepção não acessa prontuário nem vê alerta clínico; profissional sim', async () => {
    const t = await tenant('rbac');
    const rec = await t.mk('receptionist', 'rita');
    const pro = await t.mk('professional', 'dr');
    const pid = (await pro.c.post('/api/patients', { name: 'Paciente Alerta', alert: 'Alergia a penicilina' })).json().id;
    expect((await rec.c.get(`/api/patients/${pid}/notes`)).statusCode).toBe(403);
    expect((await rec.c.get(`/api/patients/${pid}`)).json().patient.alert).toBeNull();
    expect((await pro.c.get(`/api/patients/${pid}`)).json().patient.alert).toBe('Alergia a penicilina');
    expect((await rec.c.get('/api/users')).statusCode).toBe(403);
    expect((await rec.c.get('/api/audit')).statusCode).toBe(403);
  });

  it('plano Solo não inclui funcionalidade fora do plano; Master concede/bloqueia', async () => {
    const t = await tenant('plan', 'solo');
    const m = await master();
    expect((await t.owner.get('/api/me')).json().entitlements).not.toContain('crm.pipeline');
    // bloquear financeiro básico (que o plano inclui) tira o acesso no backend
    expect((await t.owner.get('/api/finance/summary')).statusCode).toBe(200);
    expect((await m.c.post(`/api/master/tenants/${t.id}/overrides`, { capability: 'finance.basic', mode: 'block', reason: 'teste de bloqueio' })).statusCode).toBe(200);
    const blocked = await t.owner.get('/api/finance/summary');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('capability_unavailable');
  });

  it('Master não consegue habilitar tiss.billing', async () => {
    const t = await tenant('tiss');
    const m = await master();
    const r = await m.c.post(`/api/master/tenants/${t.id}/overrides`, { capability: 'tiss.billing', mode: 'grant', reason: 'tentativa indevida' });
    expect(r.statusCode).toBe(409);
    expect((await t.owner.get('/api/me')).json().entitlements).not.toContain('tiss.billing');
  });
});

describe('agenda', () => {
  it('conflito concorrente: dois agendamentos no mesmo horário → um vence, outro 409', async () => {
    const t = await tenant('conc');
    await t.mk('professional', 'dr');
    const proId = ((await t.owner.get('/api/professionals')).json().professionals as { id: string }[])[0]!.id;
    const p1 = (await t.owner.post('/api/patients', { name: 'Paciente Um' })).json().id;
    const p2 = (await t.owner.post('/api/patients', { name: 'Paciente Dois' })).json().id;
    const slot = { professionalId: proId, startsAt: '2031-03-10T13:00:00Z', endsAt: '2031-03-10T13:50:00Z' };
    const [r1, r2] = await Promise.all([
      t.owner.post('/api/appointments', { ...slot, patientId: p1 }),
      t.owner.post('/api/appointments', { ...slot, patientId: p2 }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    // horário parcialmente sobreposto também conflita
    const partial = await t.owner.post('/api/appointments', { professionalId: proId, patientId: p2, startsAt: '2031-03-10T13:30:00Z', endsAt: '2031-03-10T14:20:00Z' });
    expect(partial.statusCode).toBe(409);
  });

  it('cancelamento libera o horário e exige motivo; transição inválida é recusada', async () => {
    const t = await tenant('cancel');
    await t.mk('professional', 'dr');
    const proId = ((await t.owner.get('/api/professionals')).json().professionals as { id: string }[])[0]!.id;
    const p = (await t.owner.post('/api/patients', { name: 'Paciente Cancela' })).json().id;
    const slot = { professionalId: proId, patientId: p, startsAt: '2031-04-01T13:00:00Z', endsAt: '2031-04-01T14:00:00Z' };
    const id = (await t.owner.post('/api/appointments', slot)).json().id;
    expect((await t.owner.patch(`/api/appointments/${id}`, { status: 'cancelled' })).statusCode).toBe(400);
    expect((await t.owner.patch(`/api/appointments/${id}`, { status: 'completed' })).statusCode).toBe(409);
    expect((await t.owner.patch(`/api/appointments/${id}`, { status: 'cancelled', reason: 'Paciente desistiu' })).statusCode).toBe(200);
    expect((await t.owner.post('/api/appointments', slot)).statusCode).toBe(200);
  });
});

describe('prontuário', () => {
  it('assinado é imutável; correção só por adendo; leitura é auditada', async () => {
    const t = await tenant('note');
    const pro = await t.mk('professional', 'dr');
    const other = await t.mk('professional', 'dra');
    const pid = (await pro.c.post('/api/patients', { name: 'Paciente Prontuário' })).json().id;
    const nid = (await pro.c.post(`/api/patients/${pid}/notes`, { body: 'Evolução inicial' })).json().id;
    expect((await pro.c.patch(`/api/notes/${nid}`, { body: 'Evolução inicial revisada' })).statusCode).toBe(200);
    expect((await other.c.patch(`/api/notes/${nid}`, { body: 'Intruso' })).statusCode).toBe(403);
    expect((await other.c.post(`/api/notes/${nid}/sign`)).statusCode).toBe(403);
    expect((await pro.c.post(`/api/notes/${nid}/addendum`, { body: 'x', reason: 'motivo válido' })).statusCode).toBe(409); // não assinado
    expect((await pro.c.post(`/api/notes/${nid}/sign`)).statusCode).toBe(200);
    expect((await pro.c.patch(`/api/notes/${nid}`, { body: 'Reescrita silenciosa' })).statusCode).toBe(409);
    expect((await pro.c.post(`/api/notes/${nid}/sign`)).statusCode).toBe(409);
    const add = await pro.c.post(`/api/notes/${nid}/addendum`, { body: 'Correção: dose ajustada', reason: 'Erro de digitação' });
    expect(add.statusCode).toBe(200);
    const notes = (await pro.c.get(`/api/patients/${pid}/notes`)).json().notes as { body: string; parentNoteId: string | null }[];
    expect(notes).toHaveLength(2);
    expect(notes[0]!.body).toBe('Evolução inicial revisada');
    expect(notes[1]!.parentNoteId).toBe(nid);
    const audit = (await t.owner.get('/api/audit')).json().events as { action: string }[];
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['record.read', 'note.sign', 'note.addendum']));
  });
});

describe('financeiro', () => {
  it('conclusão gera uma cobrança; pagamento idempotente; estorno limitado ao pago; valores exatos', async () => {
    const t = await tenant('fin');
    await t.mk('professional', 'dr');
    const proId = ((await t.owner.get('/api/professionals')).json().professionals as { id: string }[])[0]!.id;
    const pid = (await t.owner.post('/api/patients', { name: 'Paciente Financeiro' })).json().id;
    const aid = (await t.owner.post('/api/appointments', { patientId: pid, professionalId: proId, startsAt: '2031-05-01T13:00:00Z', endsAt: '2031-05-01T14:00:00Z', priceCents: 15050 })).json().id;
    for (const status of ['checked_in', 'completed']) expect((await t.owner.patch(`/api/appointments/${aid}`, { status })).statusCode).toBe(200);
    let fin = (await t.owner.get(`/api/patients/${pid}/finance`)).json();
    expect(fin.balanceCents).toBe('15050');
    const key = 'idem-key-12345';
    const pay = { patientId: pid, kind: 'payment', method: 'pix', amountCents: 10000, idempotencyKey: key };
    const [p1, p2] = await Promise.all([t.owner.post('/api/finance/movements', pay), t.owner.post('/api/finance/movements', pay)]);
    expect([p1.statusCode, p2.statusCode].every((s) => s === 200 || s === 409)).toBe(true);
    fin = (await t.owner.get(`/api/patients/${pid}/finance`)).json();
    expect(fin.balanceCents).toBe('5050'); // pagamento duplicado não contou duas vezes
    expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'refund', method: 'pix', amountCents: 10001 })).statusCode).toBe(400);
    expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'refund', method: 'pix', amountCents: 2500 })).statusCode).toBe(200);
    fin = (await t.owner.get(`/api/patients/${pid}/finance`)).json();
    expect(fin.balanceCents).toBe('7550');
    expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'payment', amountCents: 10.5 })).statusCode).toBe(400);
    // reabrir/concluir de novo não duplica cobrança
    expect((await t.owner.patch(`/api/appointments/${aid}`, { status: 'completed' })).statusCode).toBe(409);
  });
});

describe('Painel Master', () => {
  it('login exige MFA válido; sem código ou com código errado falha', async () => {
    const m = await master();
    const noCode = await new Client('ms').post('/api/master/login', { email: m.email, password: PW, code: '' });
    const badCode = await new Client('ms').post('/api/master/login', { email: m.email, password: PW, code: '000000' });
    expect(noCode.statusCode).toBe(401);
    expect(badCode.statusCode).toBe(401);
    expect((await m.c.get('/api/master/me')).statusCode).toBe(200);
  });

  it('sessão da clínica não acessa o Master e vice-versa', async () => {
    const t = await tenant('sep');
    const m = await master();
    const cross = new Client('ms'); cross.cookie = t.owner.cookie.replace('cs=', 'ms=');
    expect((await cross.get('/api/master/overview')).statusCode).toBe(401);
    const cross2 = new Client(); cross2.cookie = m.c.cookie.replace('ms=', 'cs=');
    expect((await cross2.get('/api/me')).statusCode).toBe(401);
  });

  it('criar clínica, suspender (com MFA e justificativa) e reativar; auditado', async () => {
    const m = await master();
    const slug = `m-${randomUUID().slice(0, 6)}`;
    const created = await m.c.post('/api/master/tenants', { name: 'Clínica Nova', slug, planCode: 'essencial', ownerName: 'Dona Nova', ownerEmail: `dona@${slug}.test`, ownerPassword: PW, justification: 'Novo contrato piloto' });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    const owner = new Client();
    expect((await owner.post('/api/auth/login', { clinic: slug, email: `dona@${slug}.test`, password: PW })).statusCode).toBe(200);

    expect((await m.c.patch(`/api/master/tenants/${id}`, { status: 'suspended', justification: 'inadimplência' })).statusCode).toBe(403); // sem MFA
    expect((await m.c.patch(`/api/master/tenants/${id}`, { status: 'suspended', code: '000000', justification: 'inadimplência' })).statusCode).toBe(403);
    expect((await m.c.patch(`/api/master/tenants/${id}`, { status: 'suspended', code: m.code(), justification: 'inadimplência' })).statusCode).toBe(200);
    const after = await owner.get('/api/me');
    expect(after.statusCode).toBe(403);
    expect(after.json().error).toBe('tenant_suspended');
    expect((await new Client().post('/api/auth/login', { clinic: slug, email: `dona@${slug}.test`, password: PW })).statusCode).toBe(401);

    expect((await m.c.patch(`/api/master/tenants/${id}`, { status: 'active', code: m.code(), justification: 'regularizado' })).statusCode).toBe(200);
    expect((await owner.get('/api/me')).statusCode).toBe(200);

    const audit = (await m.c.get('/api/master/audit')).json().events as { action: string; tenantId: string }[];
    expect(audit.filter((e) => e.tenantId === id).map((e) => e.action)).toEqual(expect.arrayContaining(['tenant.create', 'tenant.status.suspended', 'tenant.status.active']));
  });

  it('Master não lê pacientes da clínica (control plane sem acesso a dados clínicos)', async () => {
    const r = await platformPool.query('SELECT count(*) FROM patients').catch((e) => e);
    expect(String(r.message ?? '')).toMatch(/permission denied/);
  });
});
