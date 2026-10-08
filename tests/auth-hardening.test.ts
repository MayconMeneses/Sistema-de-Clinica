import { randomBytes, scryptSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { hashPassword, needsRehash, verifyPassword } from '../src/server/auth/password.js';
import { totpAt } from '../src/server/auth/totp.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { PW, tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { delete process.env.LOGIN_IP_MAX; await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const login = (clinic: string, email: string, password: string, ip: string, code?: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, headers: { 'x-requested-with': 'clinica-one' }, payload: { clinic, email, password, ...(code ? { code } : {}) } });
const ipOf = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

describe('senhas: custo atual, compatibilidade e recifra', () => {
  it('hash novo usa N=2^15/r=8/p=3; hash antigo continua valendo; parâmetros adulterados são recusados', async () => {
    const h = await hashPassword('Senha-Forte-123');
    expect(h.startsWith('scrypt$32768$8$3$')).toBe(true);
    expect(await verifyPassword('Senha-Forte-123', h)).toBe(true);
    expect(await verifyPassword('Senha-Errada-123', h)).toBe(false);
    expect(needsRehash(h)).toBe(false);
    const salt = randomBytes(16);
    const old = `scrypt$16384$8$1$${salt.toString('base64')}$${scryptSync('Senha-Antiga-123', salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
    expect(await verifyPassword('Senha-Antiga-123', old)).toBe(true);
    expect(needsRehash(old)).toBe(true);
    // custo absurdo gravado no banco não pode esgotar a memória: recusado sem calcular
    const t0 = Date.now();
    expect(await verifyPassword('x', `scrypt$${2 ** 30}$8$1$${salt.toString('base64')}$${Buffer.alloc(32).toString('base64')}`)).toBe(false);
    expect(await verifyPassword('x', `scrypt$1000$8$1$${salt.toString('base64')}$${Buffer.alloc(32).toString('base64')}`)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('login correto recifra um hash antigo; a senha continua a mesma', async () => {
    const t = await tenant('rehash');
    const email = `dono@${t.slug}.test`;
    const salt = randomBytes(16);
    const old = `scrypt$16384$8$1$${salt.toString('base64')}$${scryptSync(PW, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
    await withTenant(appPool, t.id, (tx) => tx.query('UPDATE users SET password_hash = $1 WHERE email = $2', [old, email]));
    expect((await login(t.slug, email, PW, ipOf())).statusCode).toBe(200);
    const now = await withTenant(appPool, t.id, async (tx) => (await tx.query('SELECT password_hash FROM users WHERE email = $1', [email])).rows[0].password_hash as string);
    expect(now.startsWith('scrypt$32768$8$3$')).toBe(true);
    expect((await login(t.slug, email, PW, ipOf())).statusCode).toBe(200);
  });
});

describe('limites de tentativa além do par IP+conta', () => {
  it('um IP que erra em várias contas é barrado, e outro IP segue normal', async () => {
    const t = await tenant('iplimit');
    const ip = ipOf();
    process.env.LOGIN_IP_MAX = '3';                 // depois de criar a clínica: o auxiliar de teste entra por 127.0.0.1, que já acumulou falhas de outros testes
    try {
    for (let i = 0; i < 3; i++) expect((await login(t.slug, `conta${i}@${t.slug}.test`, 'Senha-Errada-123', ip)).statusCode).toBe(401);
    expect((await login(t.slug, `outra@${t.slug}.test`, 'Senha-Errada-123', ip)).statusCode).toBe(429);
    expect((await login(t.slug, `dono@${t.slug}.test`, PW, ip)).statusCode).toBe(429);          // nem a senha certa passa enquanto o IP está barrado
    expect((await login(t.slug, `dono@${t.slug}.test`, PW, ipOf())).statusCode).toBe(200);      // outro IP, legítimo
    } finally { process.env.LOGIN_IP_MAX = '100000'; }
  });

  it('código MFA errado repetido de vários IPs trava o código da conta; senha errada não trava ninguém por esse caminho', async () => {
    const t = await tenant('mfalimit');
    const email = `dono@${t.slug}.test`;
    const setup = (await t.owner.post('/api/me/mfa/setup', { password: PW })).json() as { secret: string };
    const step = Date.now() - 30000;                                    // passo anterior: o login seguinte usa o atual
    expect((await t.owner.post('/api/me/mfa/enable', { code: totpAt(setup.secret, step) })).statusCode).toBe(200);
    for (let i = 0; i < 10; i++) expect((await login(t.slug, email, PW, ipOf(), '000000')).statusCode).toBe(401);
    // 11ª tentativa, de outro IP, com o código CERTO: a conta está travada para códigos
    const good = totpAt(setup.secret, Date.now());
    expect((await login(t.slug, email, PW, ipOf(), good)).statusCode).toBe(429);
    // quem erra a senha não consegue travar o código de ninguém: o contador só conta quem acertou a senha
    const t2 = await tenant('mfalimit2');
    const s2 = (await t2.owner.post('/api/me/mfa/setup', { password: PW })).json() as { secret: string };
    expect((await t2.owner.post('/api/me/mfa/enable', { code: totpAt(s2.secret, Date.now() - 30000) })).statusCode).toBe(200);
    for (let i = 0; i < 12; i++) await login(t2.slug, `dono@${t2.slug}.test`, 'Senha-Errada-123', ipOf(), '000000');
    expect((await login(t2.slug, `dono@${t2.slug}.test`, PW, ipOf(), totpAt(s2.secret, Date.now()))).statusCode).toBe(200);
  });
});
