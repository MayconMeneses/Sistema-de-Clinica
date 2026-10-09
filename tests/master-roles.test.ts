import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MASTER_ROUTE_PERMS, masterCan } from '../src/server/auth/master-rbac.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { routeRegistry } = await import('../src/server/context.js');
const { Client, master, tenant, state, PW } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { process.env.DEMO_SKIP_MASTER_MFA = '1'; app = await buildApp(); state.app = app; });
afterAll(async () => { delete process.env.DEMO_SKIP_MASTER_MFA; await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const J = 'teste de papéis';
async function operator(admin: Awaited<ReturnType<typeof master>>, role: string) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@master.test`;
  const r = await admin.c.post('/api/master/operators', { name: `Op ${role}`, email, role, password: PW, justification: J });
  expect(r.statusCode).toBe(200);
  expect(r.json().otpauth).toContain('otpauth://');
  const c = new Client('ms');
  expect((await c.post('/api/master/login', { email, password: PW })).statusCode).toBe(200);
  return { c, email, id: (await platformPool.query('SELECT id FROM platform_users WHERE email = $1', [email])).rows[0].id as string };
}

describe('papéis da plataforma', () => {
  it('toda rota master tem permissão declarada e nenhuma entrada sobra', () => {
    const reg = routeRegistry.filter((r) => r.kind === 'master').map((r) => `${r.method} ${r.url}`);
    for (const k of reg) expect(MASTER_ROUTE_PERMS[k], k).toBeDefined();
    for (const k of Object.keys(MASTER_ROUTE_PERMS)) expect(reg, k).toContain(k);
    expect(masterCan('admin', 'operators.manage')).toBe(true);
    expect(masterCan('billing', 'clinics.manage')).toBe(false);
  });

  it('cada papel só faz o que é seu', async () => {
    const admin = await master();
    const t = await tenant('roles', 'solo');
    const billing = await operator(admin, 'billing');
    const clinics = await operator(admin, 'clinics');
    const support = await operator(admin, 'support');
    const auditor = await operator(admin, 'auditor');
    const st = async (o: { c: InstanceType<typeof Client> }, m: 'get' | 'post' | 'patch', url: string, body: unknown = { justification: J }) =>
      (m === 'get' ? await o.c.get(url) : m === 'post' ? await o.c.post(url, body) : await o.c.patch(url, body)).statusCode;

    // cobrança
    expect(await st(billing, 'get', '/api/master/billing')).toBe(200);
    expect(await st(billing, 'post', '/api/master/billing/generate', { justification: J })).toBe(200);
    expect(await st(billing, 'patch', `/api/master/tenants/${t.id}`, { status: 'suspended', justification: J })).toBe(403);
    expect(await st(billing, 'post', `/api/master/tenants/${t.id}/support/open`)).toBe(403);
    expect(await st(billing, 'get', '/api/master/operators')).toBe(403);
    // gerência de clínicas
    expect(await st(clinics, 'patch', `/api/master/tenants/${t.id}`, { planCode: 'solo', justification: J })).toBe(200);
    expect(await st(clinics, 'get', '/api/master/billing')).toBe(200);                       // lê, mas não mexe
    expect(await st(clinics, 'post', '/api/master/billing/generate', { justification: J })).toBe(403);
    expect(await st(clinics, 'patch', '/api/master/plans/solo', { priceCents: 1, maxUsers: null, maxPatients: null, maxStorageMb: null, justification: J })).toBe(403);
    // suporte: só abre o que a clínica liberou
    expect(await st(support, 'get', '/api/master/support')).toBe(200);
    expect(await st(support, 'post', `/api/master/tenants/${t.id}/support/open`)).toBe(409);   // passou na permissão; sem concessão
    expect(await st(support, 'get', '/api/master/billing')).toBe(403);
    expect(await st(support, 'post', '/api/master/tenants', { name: 'x' })).toBe(403);
    // auditor: leitura
    for (const u of ['/api/master/overview', '/api/master/billing', '/api/master/integrations', '/api/master/audit']) expect(await st(auditor, 'get', u)).toBe(200);
    expect(await st(auditor, 'post', '/api/master/billing/run')).toBe(403);
    expect(await st(auditor, 'post', `/api/master/tenants/${t.id}/overrides`, { capability: 'x', mode: 'clear', reason: J })).toBe(403);
    expect(await st(auditor, 'get', '/api/master/support')).toBe(403);
    // todos veem quem são
    const me = (await support.c.get('/api/master/me')).json();
    expect(me.operator.role).toBe('support');
    expect(me.permissions).toContain('support.open');
    expect(me.permissions).not.toContain('billing.manage');
    // quem não é admin não cria operador nem sobe o próprio papel
    expect(await st(clinics, 'post', '/api/master/operators', { name: 'Xx', email: 'x@y.test', role: 'admin', password: PW, justification: J })).toBe(403);
    expect(await st(clinics, 'patch', `/api/master/operators/${clinics.id}`, { role: 'admin', justification: J })).toBe(403);
  });

  it('gestão de operadores: sessão cai ao mudar papel; último admin e autoalteração protegidos', async () => {
    const admin = await master();
    const op = await operator(admin, 'billing');
    expect((await op.c.get('/api/master/billing')).statusCode).toBe(200);
    expect((await admin.c.patch(`/api/master/operators/${op.id}`, { role: 'auditor', justification: J })).statusCode).toBe(200);
    expect((await op.c.get('/api/master/billing')).statusCode).toBe(401);                    // sessão revogada
    expect((await new Client('ms').post('/api/master/login', { email: op.email, password: PW })).statusCode).toBe(200);
    expect((await admin.c.patch(`/api/master/operators/${op.id}`, { status: 'suspended', justification: J })).statusCode).toBe(200);
    expect((await new Client('ms').post('/api/master/login', { email: op.email, password: PW })).statusCode).toBe(401);
    // não rebaixa a si mesmo
    const me = (await platformPool.query('SELECT id FROM platform_users WHERE email = $1', [admin.email])).rows[0].id as string;
    expect((await admin.c.patch(`/api/master/operators/${me}`, { role: 'auditor', justification: J })).statusCode).toBe(409);
    expect((await admin.c.patch(`/api/master/operators/${me}`, { status: 'suspended', justification: J })).statusCode).toBe(409);
    // e-mail repetido, senha fraca, papel inválido
    expect((await admin.c.post('/api/master/operators', { name: 'Dup', email: admin.email, role: 'auditor', password: PW, justification: J })).statusCode).toBe(409);
    expect((await admin.c.post('/api/master/operators', { name: 'Fraco', email: 'f@y.test', role: 'auditor', password: '123', justification: J })).statusCode).toBe(400);
    expect((await admin.c.post('/api/master/operators', { name: 'Papel', email: 'p@y.test', role: 'dono', password: PW, justification: J })).statusCode).toBe(400);
    expect((await admin.c.patch(`/api/master/operators/${me}`, { justification: J })).statusCode).toBe(400);
  });

  it('criar operador e alterar papel exigem MFA quando ativo', async () => {
    const admin = await master();
    delete process.env.DEMO_SKIP_MASTER_MFA;
    try {
      expect((await admin.c.post('/api/master/operators', { name: 'Sem MFA', email: 'm@y.test', role: 'auditor', password: PW, justification: J })).statusCode).toBe(403);
    } finally { process.env.DEMO_SKIP_MASTER_MFA = '1'; }
  });
});
