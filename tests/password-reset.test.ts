import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { sandboxSent } from '../src/integrations/sandbox.js';
import { processOutbox } from '../src/worker/outbox.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { Client, PW, tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const NEW_PW = 'Nova-Senha-456!';
const forgot = (clinic: string, email: string) => new Client().post('/api/auth/forgot', { clinic, email });
async function mailLink(): Promise<{ clinic: string; token: string }> {
  await processOutbox({ workerPool, appPool });
  const m = [...sandboxSent].reverse().find((x) => x.templateName === 'password_reset')!;
  const u = new URL(m.body!.match(/https?:\/\/\S+/)![0]);
  const q = new URLSearchParams(u.hash.split('?')[1]);
  return { clinic: q.get('clinic')!, token: q.get('token')! };
}

describe('recuperação de senha por e-mail', () => {
  it('pede, recebe o link, troca a senha, derruba as sessões e o link só vale uma vez', async () => {
    const t = await tenant('pwreset');
    const email = `dono@${t.slug}.test`;
    const logged = new Client();                                          // sessão aberta antes da troca
    expect((await logged.post('/api/auth/login', { clinic: t.slug, email, password: PW })).statusCode).toBe(200);

    const r = await forgot(t.slug, email);
    expect(r.statusCode).toBe(200);
    const { clinic, token } = await mailLink();
    expect(clinic).toBe(t.slug);
    // o banco guarda só o hash; o token cifrado some depois do envio
    const row = await withTenant(appPool, t.id, async (tx) => (await tx.query('SELECT token_hash, token_enc FROM password_resets')).rows[0]);
    expect(row.token_hash).not.toContain(token);
    expect(row.token_enc).toBeNull();

    const reset = new Client();
    expect((await reset.post('/api/auth/reset', { clinic, token, password: 'curta' })).statusCode).toBe(400);   // política de senha
    expect((await reset.post('/api/auth/reset', { clinic, token, password: NEW_PW })).statusCode).toBe(200);
    expect((await reset.post('/api/auth/reset', { clinic, token, password: NEW_PW + 'x' })).statusCode).toBe(400); // segundo uso
    expect((await logged.get('/api/me')).statusCode).toBe(401);                                                 // sessão antiga derrubada
    expect((await new Client().post('/api/auth/login', { clinic: t.slug, email, password: PW })).statusCode).toBe(401);
    expect((await new Client().post('/api/auth/login', { clinic: t.slug, email, password: NEW_PW })).statusCode).toBe(200);
    const audit = await withTenant(appPool, t.id, async (tx) => (await tx.query(`SELECT action FROM audit_events WHERE action LIKE 'auth.password_reset%' ORDER BY occurred_at`)).rows.map((x) => x.action));
    expect(audit).toEqual(['auth.password_reset_requested', 'auth.password_reset_done']);
  });

  it('não revela se o e-mail existe, ignora clínica inexistente e só o link mais recente vale', async () => {
    const t = await tenant('pwreset2');
    const email = `dono@${t.slug}.test`;
    const a = await forgot(t.slug, email);
    const b = await forgot(t.slug, `ninguem-${randomUUID().slice(0, 6)}@x.test`);
    const c = await forgot('clinica-que-nao-existe', email);
    expect(b.json()).toEqual(a.json());
    expect(c.json()).toEqual(a.json());
    const first = await mailLink();
    await forgot(t.slug, email);                                          // segundo pedido invalida o primeiro
    const second = await mailLink();
    expect(second.token).not.toBe(first.token);
    expect((await new Client().post('/api/auth/reset', { ...first, password: NEW_PW })).statusCode).toBe(400);
    expect((await new Client().post('/api/auth/reset', { ...second, password: NEW_PW })).statusCode).toBe(200);
    // link de outra clínica não funciona nesta
    const other = await tenant('pwreset3');
    await forgot(other.slug, `dono@${other.slug}.test`);
    const o = await mailLink();
    expect((await new Client().post('/api/auth/reset', { clinic: t.slug, token: o.token, password: NEW_PW })).statusCode).toBe(400);
  });

  it('link expirado e excesso de pedidos não geram redefinição', async () => {
    const t = await tenant('pwreset4');
    const email = `dono@${t.slug}.test`;
    await forgot(t.slug, email);
    const { clinic, token } = await mailLink();
    const { Pool } = await import('pg');
    const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER ?? 'postgres://clinica_owner:dev_owner_pw@127.0.0.1:5432/clinica_one' });
    await owner.query('BEGIN');
    await owner.query("CREATE POLICY tmp_pw ON password_resets FOR ALL TO clinica_owner USING (true) WITH CHECK (true)");
    await owner.query("ALTER TABLE password_resets DISABLE TRIGGER password_resets_guard_trg");
    await owner.query("UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1", [t.id]);
    await owner.query("ALTER TABLE password_resets ENABLE TRIGGER password_resets_guard_trg");
    await owner.query('DROP POLICY tmp_pw ON password_resets');
    await owner.query('COMMIT'); await owner.end();
    expect((await new Client().post('/api/auth/reset', { clinic, token, password: NEW_PW })).statusCode).toBe(400);

    // limite de pedidos: o 6º pedido seguido não cria nada novo
    const t2 = await tenant('pwreset5');
    for (let i = 0; i < 7; i++) await forgot(t2.slug, `dono@${t2.slug}.test`);
    const n = await withTenant(appPool, t2.id, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM password_resets')).rows[0].n as number);
    expect(n).toBeLessThanOrEqual(5);
  });
});
