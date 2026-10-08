import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasPermission } from '../src/server/auth/rbac.js';

const { buildApp } = await import('../src/server/app.js');
const { routeRegistry } = await import('../src/server/context.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { Client, tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const fill = (url: string) => url.replace(/:[A-Za-z]+/g, () => randomUUID());
const ROLES = ['receptionist', 'professional', 'finance', 'stock', 'marketing', 'auditor', 'unit_manager', 'admin'] as const;
const clinicRoutes = () => routeRegistry.filter((r) => r.kind === 'clinic');
// Autoatendimento da própria conta: não pode ser exercitado com corpo vazio em massa (encerra a sessão/troca senha).
const SELF = new Set(['/api/auth/logout', '/api/me/password']);

describe('matriz de rotas: toda rota exige sessão e respeita o papel', () => {
  it('o registro enxerga as rotas autenticadas (guarda contra o teste ficar vazio)', () => {
    expect(clinicRoutes().length).toBeGreaterThan(100);
    expect(routeRegistry.filter((r) => r.kind === 'master').length).toBeGreaterThan(5);
  });

  it('sem sessão: toda rota da clínica e do Master responde 401 e nunca 5xx', async () => {
    const anon = new Client();
    const bad: string[] = [];
    for (const r of routeRegistry) {
      const res = await anon.req(r.method as 'GET', fill(r.url), r.method === 'GET' ? undefined : {});
      if (res.statusCode !== 401) bad.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  it('com sessão: papel sem a permissão da rota recebe 403; nenhuma rota devolve 5xx a entradas inválidas', async () => {
    const t = await tenant('matrix');
    const wrong: string[] = [];
    const errors: string[] = [];
    const clients: Record<string, InstanceType<typeof Client>> = {};
    for (const role of ROLES) clients[role] = (await t.mk(role, role.replace('_', ''))).c;
    for (const r of clinicRoutes()) {
      if (SELF.has(r.url)) continue;
      for (const role of ROLES) {
        const res = await clients[role]!.req(r.method as 'GET', fill(r.url), r.method === 'GET' ? undefined : {});
        if (res.statusCode >= 500) errors.push(`${role} ${r.method} ${r.url} → ${res.statusCode}`);
        if (r.perm && !hasPermission(role, r.perm) && res.statusCode !== 403) wrong.push(`${role} ${r.method} ${r.url} esperava 403, veio ${res.statusCode}`);
      }
      const own = await t.owner.req(r.method as 'GET', fill(r.url), r.method === 'GET' ? undefined : {});
      if (own.statusCode >= 500) errors.push(`owner ${r.method} ${r.url} → ${own.statusCode}`);
    }
    expect(wrong).toEqual([]);
    expect(errors).toEqual([]);
  }, 300_000);

  it('rotas sem permissão declarada são só as de autoatendimento e o painel', () => {
    const open = clinicRoutes().filter((r) => !r.perm).map((r) => `${r.method} ${r.url}`).sort();
    expect(open).toEqual([
      'GET /api/dashboard', 'GET /api/me', 'POST /api/auth/logout', 'POST /api/me/mfa/disable', 'POST /api/me/mfa/enable', 'POST /api/me/mfa/setup', 'POST /api/me/password',
    ]);
  });
});
