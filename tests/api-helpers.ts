import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { hashPassword } from '../src/server/auth/password.js';
import { generateSecret, totpAt } from '../src/server/auth/totp.js';
import { encryptSecret } from '../src/server/crypto.js';
import { platformPool } from '../src/server/db.js';

export const PW = 'Senha-Teste-123';
/** O arquivo de teste atribui `state.app` após buildApp(). */
export const state = {} as { app: FastifyInstance };

export class Client {
  cookie = '';
  constructor(private prefix = '') {}
  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const res = await state.app.inject({
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
  del = (u: string) => this.req('DELETE', u);
}

export async function tenant(label: string, plan = 'completa') {
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

/** Cada código TOTP vale uma vez: o login usa o passo anterior; code() entrega passos 0, +1 (janela ±1). */
export async function master() {
  const email = `m-${randomUUID().slice(0, 6)}@master.test`;
  const secret = generateSecret();
  await platformPool.query('INSERT INTO platform_users (email, name, password_hash, totp_secret) VALUES ($1,$2,$3,$4)', [email, 'Op', await hashPassword(PW), encryptSecret(secret)]);
  const c = new Client('ms');
  const r = await c.post('/api/master/login', { email, password: PW, code: totpAt(secret, Date.now() - 30000) });
  expect(r.statusCode).toBe(200);
  let n = 0;
  return { c, email, secret, code: () => totpAt(secret, Date.now() + 30000 * n++) };
}

