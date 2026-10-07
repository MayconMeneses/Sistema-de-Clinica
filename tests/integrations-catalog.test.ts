import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTEGRATION_CATALOG } from '../src/integrations/catalog.js';
import { resolveNfse } from '../src/integrations/nfse.js';
import { integrationHealth } from '../src/integrations/registry.js';
import { resolveSignature, sandboxSign } from '../src/integrations/signature.js';
import { AdapterError } from '../src/integrations/types.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { master, state } = await import('./api-helpers.js');
let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

describe('catálogo único de integrações', () => {
  it('cada item é completo, sem repetição, e nada vaza valor de credencial', () => {
    const kinds = INTEGRATION_CATALOG.map((c) => c.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toEqual(expect.arrayContaining(['whatsapp', 'email', 'sms', 'payments', 'nfse', 'signature', 'storage', 'backup', 'calendar', 'observability']));
    for (const c of INTEGRATION_CATALOG) {
      expect(c.label.length, c.kind).toBeGreaterThan(2);
      expect(c.pending.length, c.kind).toBeGreaterThan(10);
      for (const v of c.env) expect(v, c.kind).toMatch(/^[A-Z][A-Z0-9_]+( \(opcional\))?$/);   // só nomes de variáveis
    }
    const pay = INTEGRATION_CATALOG.find((c) => c.kind === 'payments')!;
    expect(pay).toMatchObject({ provider: 'Mercado Pago', scope: 'clinic', liveAdapter: 'written', validatedWithProvider: false });
    expect(INTEGRATION_CATALOG.every((c) => c.validatedWithProvider === false)).toBe(true);   // nenhum foi validado com o provedor real
    const health = integrationHealth();
    expect(health.find((h) => h.kind === 'payments')).toMatchObject({ perClinic: true, configured: false, portReady: true, sandbox: true });
    expect(JSON.stringify(health)).not.toMatch(/Bearer|APP_USR|sk_/);
  });

  it('o Painel Master recebe o catálogo completo (sem credenciais)', async () => {
    const m = await master();
    const r = (await m.c.get('/api/master/integrations')).json();
    const kinds = (r.providers as { kind: string }[]).map((p) => p.kind);
    expect(kinds).toEqual(INTEGRATION_CATALOG.map((c) => c.kind));
    const pay = (r.providers as { kind: string; scope: string; env: string[]; pending: string }[]).find((p) => p.kind === 'payments')!;
    expect(pay.scope).toBe('clinic');
    expect(pay.env).toContain('PUBLIC_BASE_URL');
    expect(pay.pending).toMatch(/Access Token/);
  });
});

describe('NFS-e: porta e sandbox (adaptador real pendente)', () => {
  it('sandbox numera notas fictícias de forma idempotente; modo real recusa com mensagem clara', async () => {
    const n = resolveNfse('sandbox');
    const input = { idempotencyKey: `nf-${Date.now()}`, takerName: 'Fulano', description: 'Consulta', amountCents: 15000, municipalServiceCode: '4.02' };
    const a = await n.emit(input);
    expect(a.number).toMatch(/^HOMOLOG-\d{6}$/);
    expect((await n.emit(input)).number).toBe(a.number);
    await expect(n.emit({ ...input, idempotencyKey: 'outra-chave-xyz', amountCents: 0 })).rejects.toBeInstanceOf(AdapterError);
    await n.cancel(a.number, 'Emitida por engano');
    await expect(n.cancel('HOMOLOG-999999', 'x')).rejects.toBeInstanceOf(AdapterError);
    expect(() => resolveNfse('live')).toThrow(/ainda não foi implementada/);
  });
});

describe('Assinatura eletrônica: porta e sandbox (adaptador real pendente)', () => {
  it('cria pedido idempotente, acompanha até assinar e rejeita pedido inválido', async () => {
    const s = resolveSignature('sandbox');
    const input = { idempotencyKey: `sg-${Date.now()}`, documentName: 'Orçamento v2', documentSha256: 'a'.repeat(64), signers: [{ name: 'Paciente', email: 'p@exemplo.com', role: 'patient' as const }] };
    const r = await s.createRequest(input);
    expect(r.signUrls['p@exemplo.com']).toMatch(/^https:\/\/sandbox\.invalid\/sign\//);
    expect((await s.createRequest(input)).requestId).toBe(r.requestId);
    expect(await s.getStatus(r.requestId)).toEqual({ status: 'pending', signedAt: null });
    expect(sandboxSign(r.requestId)).toBe(true);
    expect((await s.getStatus(r.requestId)).status).toBe('signed');
    await expect(s.createRequest({ ...input, idempotencyKey: 'k-invalida-1', documentSha256: 'curto' })).rejects.toBeInstanceOf(AdapterError);
    await expect(s.createRequest({ ...input, idempotencyKey: 'k-invalida-2', signers: [] })).rejects.toBeInstanceOf(AdapterError);
    await expect(s.getStatus('inexistente')).rejects.toBeInstanceOf(AdapterError);
    expect(() => resolveSignature('live')).toThrow(/ainda não foi implementada/);
  });
});
