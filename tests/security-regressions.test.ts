import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.js';
import { decryptSecret, encryptSecret } from '../src/server/crypto.js';

const { buildApp } = await import('../src/server/app.js');
const { errorHandler } = await import('../src/server/http.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

describe('regressões da auditoria de segurança', () => {
  it('PATCH de paciente sem campos não responde sucesso para um id inexistente', async () => {
    const t = await tenant('sec1');
    const id = (await t.owner.post('/api/patients', { name: 'Paciente Sec' })).json().id as string;
    expect((await t.owner.patch(`/api/patients/${id}`, {})).statusCode).toBe(200);
    expect((await t.owner.patch('/api/patients/00000000-0000-4000-8000-000000000001', {})).statusCode).toBe(404);
  });

  it('o painel só conta pacientes para quem pode ler pacientes', async () => {
    const t = await tenant('sec2');
    const mkt = await t.mk('marketing', 'mkt');
    const rec = await t.mk('receptionist', 'rec');
    expect((await mkt.c.get('/api/dashboard')).json().patients).toBeUndefined();
    expect(typeof (await rec.c.get('/api/dashboard')).json().patients).toBe('number');
  });

  it('administrador não cria nem altera outro administrador; o proprietário pode', async () => {
    const t = await tenant('sec3');
    const adm = await t.mk('admin', 'adm1');
    const body = (role: string, n: string) => ({ name: `Usuário ${n}`, email: `${n}@${t.slug}.test`, role, password: 'Senha-Teste-123' });
    expect((await adm.c.post('/api/users', body('admin', 'novoadmin'))).statusCode).toBe(403);
    expect((await adm.c.post('/api/users', body('receptionist', 'recep'))).statusCode).toBe(200);        // papéis comuns continuam permitidos
    const other = await t.mk('admin', 'adm2');
    const users = (await t.owner.get('/api/users')).json().users as { id: string; email: string }[];
    const otherId = users.find((u) => u.email === other.email)!.id;
    expect((await adm.c.patch(`/api/users/${otherId}`, { resetMfa: true })).statusCode).toBe(403);
    expect((await adm.c.patch(`/api/users/${otherId}`, { password: 'Outra-Senha-123' })).statusCode).toBe(403);
    expect((await t.owner.patch(`/api/users/${otherId}`, { resetMfa: true })).statusCode).toBe(200);
    expect((await t.owner.post('/api/users', body('admin', 'adminpeloowner'))).statusCode).toBe(200);
  });

  it('erro interno nunca grava no log o texto do erro do banco (valores de linhas) nem a pilha', () => {
    const lines: string[] = [];
    const log = { error: (o: object, m: string) => lines.push(JSON.stringify({ o, m })) };
    const dbErr = Object.assign(new Error('duplicate key value violates unique constraint "x" para joao.silva@example.test'), {
      code: '23505', detail: 'Key (email)=(joao.silva@example.test) already exists.', where: 'linha com 12345678901', stack: 'Error: x\n    at f (/app/src/server/routes/patients.ts:10:3)',
    });
    const reply = { status: () => ({ send: () => undefined }) };
    errorHandler(dbErr, { id: 'req-1', log, routeOptions: { url: '/x' }, method: 'POST' } as never, reply as never);
    const logged = lines.join('\n');
    expect(logged).not.toContain('joao.silva@example.test');
    expect(logged).not.toContain('12345678901');
    expect(logged).not.toContain('already exists');
    expect(logged).toContain('src/server/routes/patients.ts:10');       // onde nasceu continua disponível para o suporte
  });

  it('em produção, segredo sem cifragem é recusado em vez de aceito como está', () => {
    const enc = encryptSecret('segredo');
    expect(decryptSecret(enc)).toBe('segredo');
    expect(decryptSecret('legado-em-claro')).toBe('legado-em-claro');          // desenvolvimento: tolera
    const was = config.isProd;
    (config as { isProd: boolean }).isProd = true;
    try {
      expect(() => decryptSecret('legado-em-claro')).toThrow(/sem cifragem/);
      expect(decryptSecret(enc)).toBe('segredo');                              // o cifrado segue funcionando
    } finally { (config as { isProd: boolean }).isProd = was; }
  });
});
