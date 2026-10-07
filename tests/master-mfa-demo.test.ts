import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/server/auth/password.js';
import { generateSecret } from '../src/server/auth/totp.js';
import { encryptSecret } from '../src/server/crypto.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { Client, PW, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });
afterEach(() => { delete process.env.DEMO_SKIP_MASTER_MFA; });

async function operator() {
  const email = `d-${randomUUID().slice(0, 6)}@master.test`;
  await platformPool.query('INSERT INTO platform_users (email, name, password_hash, totp_secret) VALUES ($1,$2,$3,$4)', [email, 'Op', await hashPassword(PW), encryptSecret(generateSecret())]);
  return email;
}

describe('modo demonstração: Master sem código MFA', () => {
  it('por padrão o código continua obrigatório', async () => {
    const email = await operator();
    expect((await new Client('ms').get('/api/master/auth-info')).json()).toEqual({ mfaRequired: true });
    expect((await new Client('ms').post('/api/master/login', { email, password: PW })).statusCode).toBe(401);
    expect((await new Client('ms').post('/api/master/login', { email, password: PW, code: '000000' })).statusCode).toBe(401);
  });

  it('com DEMO_SKIP_MASTER_MFA=1 entra só com senha, e senha errada continua barrada', async () => {
    process.env.DEMO_SKIP_MASTER_MFA = '1';
    const email = await operator();
    expect((await new Client('ms').get('/api/master/auth-info')).json()).toEqual({ mfaRequired: false });
    expect((await new Client('ms').post('/api/master/login', { email, password: 'errada-errada-1' })).statusCode).toBe(401);
    const c = new Client('ms');
    expect((await c.post('/api/master/login', { email, password: PW })).statusCode).toBe(200);
    expect((await c.get('/api/master/me')).statusCode).toBe(200);
    // ação crítica também dispensa o código
    const t = await platformPool.query<{ id: string }>("INSERT INTO tenants (slug, name, plan_code, status) VALUES ($1,'Clínica demo mfa','solo','active') RETURNING id", [`mfa-${randomUUID().slice(0, 6)}`]);
    const r = await c.patch(`/api/master/tenants/${t.rows[0]!.id}`, { status: 'suspended', justification: 'teste sem MFA' });
    expect(r.statusCode).toBe(200);
    const a = await platformPool.query("SELECT justification FROM platform_audit_events WHERE action = 'master.login' AND operator_id = $1", [email]);
    expect(a.rows[0].justification).toContain('SEM MFA');
  });
});
