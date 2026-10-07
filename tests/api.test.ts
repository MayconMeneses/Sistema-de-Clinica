import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/server/auth/password.js';
import { generateSecret, totpAt } from '../src/server/auth/totp.js';
import { encryptSecret } from '../src/server/crypto.js';

process.env.DATABASE_URL_APP ??= 'postgres://clinica_app:dev_app_pw@127.0.0.1:5432/clinica_one';
process.env.DATABASE_URL_PLATFORM ??= 'postgres://clinica_platform:dev_platform_pw@127.0.0.1:5432/clinica_one';
const { buildApp } = await import('../src/server/app.js');
const { platformPool, appPool: serverAppPool } = await import('../src/server/db.js');
const { PW, Client, tenant, master, state } = await import('./api-helpers.js');

let app: FastifyInstance;

beforeAll(async () => { app = await buildApp(); state.app = app; });

// Códigos TOTP são calculados no teste e verificados pelo servidor logo depois. Se a virada do passo de 30s
// cair entre os dois, o código do "passo anterior" sai da janela ±1 e o teste falha sem defeito do produto.
// Começar cada teste na primeira parte do passo elimina essa corrida.
beforeEach(async () => {
  const pos = Date.now() % 30000;
  if (pos > 25000) await new Promise((r) => setTimeout(r, 30000 - pos + 300));
});
afterAll(async () => { await app.close(); await serverAppPool.end(); await platformPool.end(); });

describe('versão do frontend (atualização automática do app)', () => {
  it('/api/version é público, estável e sem cache; index.html não fica em cache', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/version' });
    const b = await app.inject({ method: 'GET', url: '/api/version' });
    expect(a.statusCode).toBe(200);
    expect(a.json().version).toBeTypeOf('string');
    expect(a.json().version).toBe(b.json().version);
    expect(a.headers['cache-control']).toBe('no-store');
    const idx = await app.inject({ method: 'GET', url: '/' });
    if (a.json().version !== 'dev') expect(idx.headers['cache-control']).toContain('no-cache');
  });
});

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

describe('MFA, anti-replay e segredos', () => {
  it('Master: código já usado no login não vale de novo (replay)', async () => {
    const email = `r-${randomUUID().slice(0, 6)}@master.test`;
    const secret = generateSecret();
    await platformPool.query('INSERT INTO platform_users (email, name, password_hash, totp_secret) VALUES ($1,$2,$3,$4)', [email, 'Op', await hashPassword(PW), encryptSecret(secret)]);
    const code = totpAt(secret, Date.now());
    expect((await new Client('ms').post('/api/master/login', { email, password: PW, code })).statusCode).toBe(200);
    expect((await new Client('ms').post('/api/master/login', { email, password: PW, code })).statusCode).toBe(401);
  });

  it('segredos TOTP ficam cifrados em repouso (Master e clínica)', async () => {
    const m = await master();
    const row = await platformPool.query('SELECT totp_secret FROM platform_users WHERE email = $1', [m.email]);
    expect(row.rows[0].totp_secret).toMatch(/^v1:/);
    expect(row.rows[0].totp_secret).not.toContain(m.secret);
  });

  it('MFA da clínica: ativar, exigir no login, bloquear replay e desativar', async () => {
    const t = await tenant('mfa');
    const email = `dono@${t.slug}.test`;
    expect((await t.owner.post('/api/me/mfa/setup', { password: 'senha-errada-x' })).statusCode).toBe(400);
    const setup = await t.owner.post('/api/me/mfa/setup', { password: PW });
    expect(setup.statusCode).toBe(200);
    const { secret, otpauth } = setup.json() as { secret: string; otpauth: string };
    expect(otpauth).toContain('otpauth://totp/');
    expect((await t.owner.post('/api/me/mfa/enable', { code: '000000' })).statusCode).toBe(400);
    expect((await t.owner.post('/api/me/mfa/enable', { code: totpAt(secret, Date.now() - 30000) })).statusCode).toBe(200);
    expect((await t.owner.get('/api/me')).json().mfaEnabled).toBe(true);

    const login = (code?: string) => new Client().post('/api/auth/login', { clinic: t.slug, email, password: PW, ...(code ? { code } : {}) });
    const noCode = await login();
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().error).toBe('mfa_required');
    expect((await login('000000')).statusCode).toBe(401);
    const good = totpAt(secret, Date.now());
    expect((await login(good)).statusCode).toBe(200);
    expect((await login(good)).statusCode).toBe(401); // replay do mesmo código

    expect((await t.owner.post('/api/me/mfa/disable', { password: PW, code: totpAt(secret, Date.now() + 30000) })).statusCode).toBe(200);
    expect((await login()).statusCode).toBe(200);
  });

  it('Master recupera o MFA do proprietário sem ler dados; sessões antigas caem', async () => {
    const t = await tenant('recover');
    const { secret } = (await t.owner.post('/api/me/mfa/setup', { password: PW })).json() as { secret: string };
    await t.owner.post('/api/me/mfa/enable', { code: totpAt(secret, Date.now() - 30000) });
    const m = await master();
    expect((await m.c.post(`/api/master/tenants/${t.id}/reset-owner-mfa`, { code: '000000', justification: 'proprietário perdeu o celular' })).statusCode).toBe(403);
    expect((await m.c.post(`/api/master/tenants/${t.id}/reset-owner-mfa`, { code: m.code(), justification: 'proprietário perdeu o celular' })).statusCode).toBe(200);
    expect((await t.owner.get('/api/me')).statusCode).toBe(401); // sessão antiga invalidada
    const relog = await new Client().post('/api/auth/login', { clinic: t.slug, email: `dono@${t.slug}.test`, password: PW });
    expect(relog.statusCode).toBe(200);
    const audit = (await m.c.get('/api/master/audit')).json().events as { action: string; tenantId: string }[];
    expect(audit.some((e) => e.action === 'tenant.owner_mfa_reset' && e.tenantId === t.id)).toBe(true);
  });

  it('administrador redefine o MFA de um colaborador', async () => {
    const t = await tenant('adminreset');
    const rec = await t.mk('receptionist', 'rita');
    const { secret } = (await rec.c.post('/api/me/mfa/setup', { password: PW })).json() as { secret: string };
    await rec.c.post('/api/me/mfa/enable', { code: totpAt(secret, Date.now() - 30000) });
    const users = (await t.owner.get('/api/users')).json().users as { id: string; email: string; mfaEnabled: boolean }[];
    const u = users.find((x) => x.email === rec.email)!;
    expect(u.mfaEnabled).toBe(true);
    expect((await t.owner.patch(`/api/users/${u.id}`, { resetMfa: true })).statusCode).toBe(200);
    expect((await new Client().post('/api/auth/login', { clinic: t.slug, email: rec.email, password: PW })).statusCode).toBe(200);
  });

  it('limitador de falhas fica no banco e guarda só hash da chave', async () => {
    const rows = await platformPool.query('SELECT key_hash FROM rate_limits');
    expect(rows.rowCount).toBeGreaterThan(0);
    for (const r of rows.rows) expect(r.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Origin malformado ("null") é bloqueado sem erro 500', async () => {
    const t = await tenant('origin');
    const r = await t.owner.req('POST', '/api/patients', { name: 'Fulano' }, { origin: 'null' });
    expect(r.statusCode).toBe(403);
  });
});

describe('odontologia', () => {
  async function setup(plan = 'completa') {
    const t = await tenant('dent', plan);
    const dr = await t.mk('professional', 'dr');
    const pid = (await dr.c.post('/api/patients', { name: 'Paciente Dental' })).json().id as string;
    return { t, dr, pid };
  }

  it('odontograma guarda histórico; estado atual é o último evento por dente/face', async () => {
    const { dr, pid } = await setup();
    const add = (b: object) => dr.c.post(`/api/patients/${pid}/odontogram/findings`, b);
    expect((await add({ tooth: '16', surface: 'O', condition: 'caries' })).statusCode).toBe(200);
    expect((await add({ tooth: '16', surface: 'O', condition: 'restoration', note: 'Resina composta' })).statusCode).toBe(200);
    expect((await add({ tooth: '16', surface: 'M', condition: 'caries' })).statusCode).toBe(200);
    expect((await add({ tooth: '46', condition: 'missing' })).statusCode).toBe(200);
    const cur = (await dr.c.get(`/api/patients/${pid}/odontogram`)).json().findings as { tooth: string; surface: string | null; condition: string }[];
    expect(cur.find((f) => f.tooth === '16' && f.surface === 'O')!.condition).toBe('restoration');
    expect(cur.find((f) => f.tooth === '16' && f.surface === 'M')!.condition).toBe('caries');
    expect(cur.find((f) => f.tooth === '46' && f.surface === null)!.condition).toBe('missing');
    const hist = (await dr.c.get(`/api/patients/${pid}/odontogram/history?tooth=16`)).json().events as { condition: string; surface: string }[];
    expect(hist).toHaveLength(3);
    expect(hist.filter((e) => e.surface === 'O').map((e) => e.condition)).toEqual(['restoration', 'caries']); // mais recente primeiro
  });

  it('valida dente (FDI), face e condição; dentição decídua é aceita', async () => {
    const { dr, pid } = await setup();
    const add = (b: object) => dr.c.post(`/api/patients/${pid}/odontogram/findings`, b);
    expect((await add({ tooth: '19', condition: 'caries', surface: 'O' })).statusCode).toBe(400);
    expect((await add({ tooth: '56', condition: 'missing' })).statusCode).toBe(400);
    expect((await add({ tooth: '55', surface: 'O', condition: 'caries' })).statusCode).toBe(200); // decíduo
    expect((await add({ tooth: '16', surface: 'O', condition: 'missing' })).statusCode).toBe(400); // ausência é do dente inteiro
    expect((await add({ tooth: '16', condition: 'inventada' })).statusCode).toBe(400);
  });

  it('eventos do odontograma são imutáveis até para o owner do banco', async () => {
    const { dr, pid } = await setup();
    await dr.c.post(`/api/patients/${pid}/odontogram/findings`, { tooth: '11', condition: 'crown' });
    const { ownerPool } = await import('./helpers.js');
    const client = await ownerPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE dental_findings NO FORCE ROW LEVEL SECURITY');
      await expect(client.query("UPDATE dental_findings SET condition = 'healthy'")).rejects.toThrow(/append-only/);
      await client.query('ROLLBACK');
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  });

  it('só profissional registra; recepção e administrador não acessam; plano Solo não inclui odontologia', async () => {
    const { t, dr, pid } = await setup();
    const rec = await t.mk('receptionist', 'rita');
    const adm = await t.mk('admin', 'ana');
    expect((await rec.c.get(`/api/patients/${pid}/odontogram`)).statusCode).toBe(403);
    expect((await adm.c.get(`/api/patients/${pid}/odontogram`)).statusCode).toBe(403);
    expect((await t.owner.post(`/api/patients/${pid}/odontogram/findings`, { tooth: '11', condition: 'crown' })).statusCode).toBe(403); // dono lê, não registra
    expect((await t.owner.get(`/api/patients/${pid}/odontogram`)).statusCode).toBe(200);
    expect((await dr.c.get(`/api/patients/${pid}/odontogram`)).statusCode).toBe(200);

    const solo = await setup('solo');
    const r = await solo.dr.c.get(`/api/patients/${solo.pid}/odontogram`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('capability_unavailable');
  });

  it('clínica B não vê odontograma de paciente da A', async () => {
    const a = await setup();
    const b = await setup();
    await a.dr.c.post(`/api/patients/${a.pid}/odontogram/findings`, { tooth: '21', condition: 'implant' });
    const r = await b.dr.c.get(`/api/patients/${a.pid}/odontogram`);
    expect(r.json().findings).toHaveLength(0);
    expect((await b.dr.c.post(`/api/patients/${a.pid}/odontogram/findings`, { tooth: '21', condition: 'implant' })).statusCode).toBe(400); // FK composta
  });

  it('plano de tratamento: total em aberto, transições, cobrança única e finalizado é imutável', async () => {
    const { t, dr, pid } = await setup();
    const mk = async (procedure: string, priceCents: number, tooth?: string) =>
      (await dr.c.post(`/api/patients/${pid}/dental-plan`, { procedure, priceCents, tooth, priority: 1 })).json().id as string;
    const a = await mk('Restauração', 25000, '16');
    const b = await mk('Limpeza', 12050);
    let plan = (await dr.c.get(`/api/patients/${pid}/dental-plan`)).json();
    expect(plan.openTotalCents).toBe('37050');
    expect((await dr.c.patch(`/api/dental-plan/${a}`, { status: 'in_progress' })).statusCode).toBe(200);
    const done = await dr.c.patch(`/api/dental-plan/${a}`, { status: 'done', charge: true });
    expect(done.json().charged).toBe(true);
    expect((await dr.c.patch(`/api/dental-plan/${a}`, { status: 'done', charge: true })).statusCode).toBe(409); // já finalizado: sem 2ª cobrança
    expect((await dr.c.patch(`/api/dental-plan/${a}`, { status: 'cancelled' })).statusCode).toBe(409);
    expect((await dr.c.patch(`/api/dental-plan/${b}`, { status: 'cancelled' })).statusCode).toBe(200);
    plan = (await dr.c.get(`/api/patients/${pid}/dental-plan`)).json();
    expect(plan.openTotalCents).toBe('0');
    const fin = (await t.owner.get(`/api/patients/${pid}/finance`)).json();
    expect(fin.balanceCents).toBe('25000');
    expect((fin.movements as { kind: string }[]).filter((m) => m.kind === 'charge')).toHaveLength(1);
  });

  it('leitura do odontograma é auditada', async () => {
    const { t, dr, pid } = await setup();
    await dr.c.get(`/api/patients/${pid}/odontogram`);
    const events = (await t.owner.get('/api/audit')).json().events as { action: string }[];
    expect(events.some((e) => e.action === 'dental.read')).toBe(true);
  });
});

describe('privacidade nos logs', () => {
  it('a busca de paciente não deixa nome nem documento nos logs', async () => {
    const { Writable } = await import('node:stream');
    const lines: string[] = [];
    const logged = await buildApp({ logStream: new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }) });
    const slug = `log-${randomUUID().slice(0, 6)}`;
    const id = randomUUID();
    await platformPool.query("INSERT INTO tenants (id, slug, name, plan_code, status) VALUES ($1,$2,'Clínica Log','completa','active')", [id, slug]);
    await platformPool.query("INSERT INTO users (id, tenant_id, email, name, password_hash, role) VALUES ($1,$2,$3,'Dono',$4,'owner')", [randomUUID(), id, `dono@${slug}.test`, await hashPassword(PW)]);
    const login = await logged.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'clinica-one' }, payload: { clinic: slug, email: `dono@${slug}.test`, password: PW } });
    const cookie = login.cookies.find((c) => c.name === 'cs')!;
    const res = await logged.inject({ method: 'GET', url: '/api/patients?q=Maria%20Souza%2012345678900', headers: { cookie: `cs=${cookie.value}` } });
    expect(res.statusCode).toBe(200);
    const text = lines.join('');
    expect(text).toContain('/api/patients');
    expect(text).not.toMatch(/Maria|Souza|12345678900/);
    expect(text).not.toContain(cookie.value);
    await logged.close();
  });
});
