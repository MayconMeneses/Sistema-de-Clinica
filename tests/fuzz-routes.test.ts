import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { buildApp } = await import('../src/server/app.js');
const { routeRegistry } = await import('../src/server/context.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const SELF = new Set(['/api/auth/logout', '/api/me/password']);
const fill = (url: string) => url.replace(/:[A-Za-z]+/g, () => randomUUID());

// Valores hostis que um cliente malicioso pode mandar em qualquer campo.
const HOSTILE: unknown[] = ['\u0000', 'A'.repeat(70_000), '', -1, 1e21, null, [], { $ne: 1 }, '2024-13-45', "' OR 1=1 --", 'not-a-uuid', '😀\u202E'];

describe('fuzz: nenhuma rota devolve 5xx para valores hostis em qualquer campo', () => {
  it('corpos: cada campo conhecido recebe cada valor hostil (dono de uma clínica sintética)', async () => {
    const t = await tenant('fuzz-body');
    const FIELDS = ['name', 'patientId', 'amountCents', 'quantity', 'itemId', 'date', 'dueOn', 'startsAt', 'reason', 'email', 'role', 'status', 'contentBase64', 'lines'];
    const bad: string[] = [];
    for (const r of routeRegistry.filter((x) => x.kind === 'clinic' && x.method !== 'GET' && !SELF.has(x.url))) {
      const url = fill(r.url);
      for (const field of FIELDS) {
        for (const v of HOSTILE) {
          const res = await t.owner.req(r.method as 'POST', url, { [field]: v });
          if (res.statusCode >= 500) bad.push(`${r.method} ${r.url} ${field}=${JSON.stringify(v)?.slice(0, 30)} → ${res.statusCode}`);
        }
      }
    }
    expect([...new Set(bad)].slice(0, 40)).toEqual([]);
  }, 900_000);

  it('consultas: parâmetros de URL hostis em todas as rotas de leitura', async () => {
    const t = await tenant('fuzz-query');
    const PARAMS = ['q', 'from', 'to', 'date', 'professionalId', 'patientId', 'status', 'unitId'];
    const VALS = ['%00', '9999-99-99', '2024-13-45', '-1', '%27%20OR%201%3D1--', 'not-a-uuid', 'A'.repeat(5000), '../..'];
    const bad: string[] = [];
    for (const r of routeRegistry.filter((x) => x.kind === 'clinic' && x.method === 'GET')) {
      for (const p of PARAMS) {
        for (const v of VALS) {
          const res = await t.owner.get(`${fill(r.url)}?${p}=${v}`);
          if (res.statusCode >= 500) bad.push(`GET ${r.url}?${p}=${v.slice(0, 20)} → ${res.statusCode}`);
        }
      }
    }
    expect([...new Set(bad)].slice(0, 40)).toEqual([]);
  }, 900_000);
});
