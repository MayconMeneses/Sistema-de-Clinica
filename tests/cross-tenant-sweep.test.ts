import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';

const { buildApp } = await import('../src/server/app.js');
const { routeRegistry } = await import('../src/server/context.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const SELF = new Set(['/api/auth/logout', '/api/me/password', '/api/me/mfa/setup', '/api/me/mfa/enable', '/api/me/mfa/disable']);
const pdf = Buffer.from('%PDF-1.4\nconteudo\n%%EOF').toString('base64');

/** Impressão digital dos dados da clínica A: qualquer escrita indevida de B a altera. */
async function fingerprint(tenantId: string, tables: string[]) {
  return withTenant(appPool, tenantId, async (tx) => {
    const out: Record<string, string> = {};
    for (const t of tables) {
      const r = await tx.query(`SELECT COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h, count(*)::int AS n FROM ${t} x`);
      out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
    }
    return out;
  });
}

describe('varredura entre clínicas: B nunca lê nem altera objetos de A, em nenhuma rota', () => {
  it('usa os ids reais de A em todas as rotas da clínica como dono de B', async () => {
    const A = await tenant('sweepa');
    const B = await tenant('sweepb');
    const MARK = `MARCA-${randomUUID().slice(0, 8)}`;
    const dr = await A.mk('professional', 'drsweep');

    // dados de A em várias áreas (todos sintéticos)
    const pid = (await dr.c.post('/api/patients', { name: `Paciente ${MARK}`, phone: '11999990000', email: `m-${MARK.toLowerCase()}@x.test` })).json().id as string;
    await dr.c.post(`/api/patients/${pid}/notes`, { body: `Evolução ${MARK}` });
    await dr.c.post(`/api/patients/${pid}/documents`, { title: `Doc ${MARK}`, category: 'other', fileName: 'a.pdf', contentBase64: pdf });
    await dr.c.post(`/api/patients/${pid}/dental-plan`, { procedure: `Proc ${MARK}`, priceCents: 1000, priority: 1 });
    await A.owner.post('/api/inventory/items', { name: `Item ${MARK}`, unit: 'un' });
    await A.owner.post('/api/suppliers', { name: `Forn ${MARK}` });
    await A.owner.post('/api/crm/leads', { name: `Lead ${MARK}`, phone: '11999991111' });
    await A.owner.post('/api/payables', { description: `Conta ${MARK}`, amountCents: 5000, dueOn: '2031-01-10' });

    // todos os ids de A, em todas as tabelas legíveis pela aplicação
    const tablesRes = await platformPool.query<{ table_name: string }>(
      `SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped)
        ORDER BY 1`);
    const ids = new Set<string>([pid]);
    const readable: string[] = [];
    for (const { table_name: t } of tablesRes.rows) {
      try {
        const r = await withTenant(appPool, A.id, (tx) => tx.query<{ id: string }>(`SELECT id::text FROM ${t} LIMIT 6`));
        if (r.rowCount) { readable.push(t); r.rows.forEach((x) => ids.add(x.id)); }
      } catch { /* sem leitura para o papel da aplicação */ }
    }
    expect(ids.size).toBeGreaterThan(15);
    const idList = [...ids].filter((i) => /^[0-9a-f-]{36}$/.test(i)).slice(0, 40);

    const before = await fingerprint(A.id, readable);
    const leaks: string[] = [];
    let calls = 0;
    for (const r of routeRegistry.filter((x) => x.kind === 'clinic' && !SELF.has(x.url))) {
      const hasParam = /:[A-Za-z]+/.test(r.url);
      for (const id of hasParam ? idList : [randomUUID()]) {
        const url = r.url.replace(/:[A-Za-z]+/g, id);
        const res = await B.owner.req(r.method as 'GET', url, r.method === 'GET' ? undefined : {});
        calls++;
        const text = res.body;
        if (res.statusCode >= 500) leaks.push(`5xx ${r.method} ${url}`);
        if (text.includes(MARK) || (r.url !== '/api/audit' && idList.some((x) => text.includes(x) && !url.includes(x)))) leaks.push(`vazou ${r.method} ${r.url}`);
        if (res.statusCode < 300 && hasParam && r.method !== 'GET' && !/\/(search|export)/.test(r.url)) leaks.push(`2xx em escrita ${r.method} ${r.url}`);
      }
    }
    const after = await fingerprint(A.id, readable);
    expect(calls).toBeGreaterThan(500);
    expect([...new Set(leaks)]).toEqual([]);
    expect(after).toEqual(before);
    void createHash;
  }, 600_000);
});
