import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sandboxAlerts, TelegramClient, TelegramTransport, type AlertTransport } from '../src/integrations/alerts/telegram.js';
import { AdapterError } from '../src/integrations/types.js';
import { locateError, Notifier, safeErrorSummary, scrub } from '../src/ops/alerts.js';
import { handleUpdate, runCommand, type BotDeps } from '../src/ops/telegram-bot.js';

const { buildApp } = await import('../src/server/app.js');
const { clinicRoute } = await import('../src/server/context.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { master, tenant, state } = await import('./api-helpers.js');

const TOKEN = '123456789:AAHfake_token_value_that_must_never_leak_1234';

// ---------------------------------------------------------------- servidor Telegram falso
let tg: Server; let base = '';
const calls: { path: string; body: { chat_id?: string; text?: string; offset?: number } }[] = [];
let respond: (path: string) => { status: number; body: object } = () => ({ status: 200, body: { ok: true, result: {} } });
beforeAll(async () => {
  tg = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      const r = respond(req.url ?? '');
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((ok) => tg.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(tg.address() as AddressInfo).port}`;
});
afterAll(() => { tg.close(); });

describe('adaptador Telegram (contra servidor falso)', () => {
  it('envia sendMessage em HTML para o chat, com o token só na URL', async () => {
    calls.length = 0; respond = () => ({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    await new TelegramClient(TOKEN, base).sendMessage('999', '<b>oi</b>');
    expect(calls[0]!.path).toBe(`/bot${TOKEN}/sendMessage`);
    expect(calls[0]!.body).toMatchObject({ chat_id: '999', text: '<b>oi</b>', parse_mode: 'HTML' });
  });
  it('429/5xx são transitórios, 401/403 definitivos, e o token nunca aparece no erro', async () => {
    const c = new TelegramClient(TOKEN, base);
    respond = () => ({ status: 429, body: { ok: false, error_code: 429, description: `Too many ${TOKEN}` } });
    const e1 = await c.sendMessage('1', 'x').catch((e) => e as AdapterError);
    expect(e1).toBeInstanceOf(AdapterError); expect((e1 as AdapterError).retryable).toBe(true);
    respond = () => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });
    const e2 = await c.sendMessage('1', 'x').catch((e) => e as AdapterError);
    expect((e2 as AdapterError).retryable).toBe(false);
    for (const e of [e1, e2]) expect(JSON.stringify({ m: (e as Error).message, c: (e as AdapterError).code })).not.toContain('AAH');
    // servidor fora do ar: erro de rede também não revela o token
    const e3 = (await new TelegramClient(TOKEN, 'http://127.0.0.1:1').sendMessage('1', 'x').catch((e) => e)) as Error;
    expect(e3.message).not.toContain(TOKEN);
  });
  it('falha em um chat não impede o envio aos outros', async () => {
    calls.length = 0;
    respond = (p) => (p.endsWith('/sendMessage') && calls.at(-1)?.body.chat_id === '111' ? { status: 403, body: { ok: false, error_code: 403 } } : { status: 200, body: { ok: true, result: {} } });
    const r = await new TelegramTransport(TOKEN, ['111', '222'], base).send('oi');
    expect(r).toEqual({ delivered: 1, failed: 1 });
    expect(calls.map((c) => c.body.chat_id)).toEqual(['111', '222']);
  });
});

describe('localização do erro', () => {
  it('aponta arquivo:linha do nosso código, sem enviar a pilha', () => {
    expect(locateError(Object.assign(new Error('y'), { stack: 'Error: y\n    at f (/app/src/server/routes/finance.ts:123:9)\n    at g (/app/node_modules/x/y.js:1:1)' }))).toBe('src/server/routes/finance.ts:123');
    expect(locateError({})).toBeUndefined();
  });
  it('o aviso inclui "Onde" e o código para buscar nos logs', () => {
    const { n } = fake();
    const m = n.format({ ...base1, where: 'src/server/routes/finance.ts:123', ref: 'req-1234' });
    expect(m).toContain('Onde: <code>src/server/routes/finance.ts:123</code>'); expect(m).toContain('Buscar nos logs');
  });
});

describe('higienização', () => {
  it('remove token, e-mail, CPF, ids, URLs e números longos', () => {
    const t = scrub(`falhou ${TOKEN} jane@x.com 123.456.789-09 ${'a1b2c3d4-0000-4000-8000-123456789abc'} postgres://u:p@h/db 12345678901234 Key (email)=(jane@x.com) already exists`);
    expect(t).not.toMatch(/AAH|jane|123\.456|a1b2c3d4|postgres:|12345678901|@/);
  });
  it('resumo de erro não inclui stack', () => {
    const e = Object.assign(new Error('duplicate key jane@x.com'), { code: '23505' });
    const s = safeErrorSummary(e);
    expect(s).toContain('23505'); expect(s).not.toContain('jane'); expect(s).not.toContain(' at ');
  });
});

// ---------------------------------------------------------------- Notifier
function fake() {
  const sent: string[] = [];
  const t: AlertTransport = { name: 'sandbox', async send(x) { sent.push(x); return { delivered: 1, failed: 0 }; } };
  let now = 1_000_000;
  const n = new Notifier({ transport: t, envLabel: 'teste', dedupeMinutes: 5, now: () => now });
  return { n, sent, tick: (ms: number) => { now += ms; } };
}
const base1 = { severity: 'critical', component: 'api', title: 'Erro interno (500)', route: 'GET /api/x' } as const;

describe('Notifier', () => {
  it('formata componente, clínica e rota, sem dados sensíveis', async () => {
    const { n, sent } = fake();
    await n.notify({ ...base1, tenant: { id: 'abcdef12-0000-0000-0000-000000000000', name: 'Clínica Sorriso' }, detail: 'Error falhou jane@x.com' });
    const m = sent[0]!;
    expect(m).toContain('CRÍTICO'); expect(m).toContain('api'); expect(m).toContain('Clínica Sorriso'); expect(m).toContain('GET /api/x');
    expect(m).not.toContain('jane');
  });
  it('agrupa repetidos por 5 min e informa a contagem depois', async () => {
    const { n, sent, tick } = fake();
    expect(await n.notify(base1)).toBe('sent');
    expect(await n.notify(base1)).toBe('deduped');
    expect(await n.notify(base1)).toBe('deduped');
    tick(6 * 60_000);
    expect(await n.notify(base1)).toBe('sent');
    expect(sent[1]).toContain('repetido 2x');
  });
  it('silenciar corta avisos comuns, mas crítico continua', async () => {
    const { n, sent } = fake();
    await n.mute(30);
    expect(await n.notify({ ...base1, severity: 'warning', title: 'a' })).toBe('muted');
    expect(await n.notify({ ...base1, title: 'b' })).toBe('sent');
    await n.unmute();
    expect(await n.notify({ ...base1, severity: 'info', title: 'c' })).toBe('sent');
    expect(sent).toHaveLength(2);
  });
  it('trava de enxurrada: após 20 avisos em 10 min só um resumo sai', async () => {
    const { n, sent } = fake();
    const r: string[] = [];
    for (let i = 0; i < 26; i++) r.push(await n.notify({ ...base1, title: `Falha tipo ${String.fromCharCode(65 + i)}` }));
    expect(r.filter((x) => x === 'sent')).toHaveLength(20);
    expect(r.filter((x) => x === 'flood')).toHaveLength(6);
    expect(sent.filter((m) => m.includes('Muitos alertas'))).toHaveLength(1);
  });
  it('sem canal configurado não falha e guarda no histórico', async () => {
    const n = new Notifier({ transport: null, envLabel: 'x', dedupeMinutes: 5 });
    expect(await n.notify(base1)).toBe('disabled');
    expect(n.recent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- comandos
describe('comandos do bot', () => {
  const sentTo: { chat: string; text: string }[] = [];
  const client = { sendMessage: async (chat: string, text: string) => { sentTo.push({ chat, text }); return {}; } };
  const deps = (): BotDeps => ({ pool: workerPool, notifier: new Notifier({ transport: { name: 'sandbox', async send() { return { delivered: 1, failed: 0 }; } }, pool: workerPool, envLabel: 'teste', dedupeMinutes: 5 }), version: '9.9.9', startedAt: Date.now() - 90 * 60_000 });
  const upd = (chat: number, text: string) => ({ update_id: 1, message: { message_id: 1, text, chat: { id: chat, type: 'private' } } });

  it('/ajuda lista todos os comandos', async () => {
    const t = await runCommand('/ajuda', deps());
    for (const c of ['/status', '/erros', '/clinicas', '/fila', '/silenciar', '/ativar', '/testar']) expect(t).toContain(c);
  });
  it('/status, /clinicas e /fila respondem com números agregados', async () => {
    const d = deps();
    const s = await runCommand('/status', d);
    expect(s).toContain('Sistema no ar'); expect(s).toContain('v9.9.9'); expect(s).toContain('1h 30min');
    expect(await runCommand('/clinicas', d)).toContain('ativas');
    expect(await runCommand('/fila', d)).toContain('Fila');
  });
  it('/silenciar valida o número e /ativar desfaz (estado no banco)', async () => {
    const d = deps();
    expect(await runCommand('/silenciar abc', d)).toContain('Use assim');
    expect(await runCommand('/silenciar 99999', d)).toContain('Use assim');
    expect(await runCommand('/silenciar 15', d)).toContain('silenciados');
    expect(await d.notifier.mutedUntil()).toBeGreaterThan(Date.now());
    await runCommand('/ativar', d);
    expect(await d.notifier.mutedUntil()).toBe(0);
  });
  it('só chats autorizados executam comandos; /start de estranho recebe só o próprio id', async () => {
    sentTo.length = 0; const hinted = new Map<string, number>();
    await handleUpdate(upd(555, '/status'), deps(), client, ['111'], hinted);
    expect(sentTo).toHaveLength(0);
    await handleUpdate(upd(555, '/start'), deps(), client, ['111'], hinted);
    expect(sentTo).toHaveLength(1); expect(sentTo[0]!.text).toContain('555'); expect(sentTo[0]!.text).not.toContain('Sistema');
    await handleUpdate(upd(555, '/start'), deps(), client, ['111'], hinted);
    expect(sentTo).toHaveLength(1); // no máximo uma dica por hora
    await handleUpdate(upd(111, '/ajuda'), deps(), client, ['111'], hinted);
    expect(sentTo).toHaveLength(2); expect(sentTo[1]!.chat).toBe('111');
  });
});

// ---------------------------------------------------------------- ponta a ponta no servidor
describe('alerta de erro real no servidor', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp(); state.app = app;
    clinicRoute(app, 'GET', '/api/_boom', {}, async () => { throw new Error('quebrou para jane@x.com'); });
  });
  beforeEach(async () => { const pos = Date.now() % 30000; if (pos > 25000) await new Promise((r) => setTimeout(r, 30000 - pos + 300)); }); // TOTP do Master
  afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

  it('um 500 avisa componente, clínica e rota (padrão), sem vazar dados', async () => {
    const t = await tenant('alerta');
    sandboxAlerts.length = 0;
    const r = await t.owner.get('/api/_boom');
    expect(r.statusCode).toBe(500);
    await new Promise((ok) => setTimeout(ok, 100));
    const m = sandboxAlerts.map((a) => a.text).join('\n');
    expect(m).toContain('Erro interno (500)'); expect(m).toContain('api'); expect(m).toContain('Clínica alerta'); expect(m).toContain('GET /api/_boom');
    expect(m).not.toContain('jane'); expect(m).not.toMatch(/\bat \w+.*\(/); // sem stack
  });
  it('o teste do Painel Master usa o próprio sistema e mostra onde o erro nasceu', async () => {
    const m = await master();
    sandboxAlerts.length = 0;
    const st = (await m.c.get('/api/master/alerts')).json();
    expect(st.transport).toBeDefined();
    const ok = await m.c.post('/api/master/alerts/test', { kind: 'simple' });
    expect(ok.statusCode).toBe(200); expect(ok.json().result).toBe('sent');
    const er = await m.c.post('/api/master/alerts/test', { kind: 'error' });
    expect(er.json().result).toBe('sent');
    const txt = sandboxAlerts.map((a) => a.text).join('\n');
    expect(txt).toContain('Teste de alerta feito pelo Painel Master');
    expect(txt).toMatch(/Onde: <code>src\/server\/routes\/master\.ts:\d+<\/code>/);
    expect(txt).toContain('POST /api/master/alerts/test'); expect(txt).toContain('Clínica de exemplo');
    expect((await new (await import('./api-helpers.js')).Client('ms').post('/api/master/alerts/test', { kind: 'simple' })).statusCode).toBe(401);
  });
  it('erro do navegador vira aviso "web", limitado por IP', async () => {
    sandboxAlerts.length = 0;
    const post = (message: string) => app.inject({ method: 'POST', url: '/api/telemetry/client-error', headers: { 'x-requested-with': 'clinica-one' }, payload: { message, page: '#/pacientes/a1b2c3d4-0000-4000-8000-123456789abc?x=1' } });
    expect((await post('TypeError: x is undefined')).statusCode).toBe(204);
    await new Promise((ok) => setTimeout(ok, 100));
    expect(sandboxAlerts.at(-1)!.text).toContain('web');
    expect(sandboxAlerts.at(-1)!.text).toContain('#/pacientes/:id');
    for (let i = 0; i < 8; i++) await post(`erro ${i}`);
    await new Promise((ok) => setTimeout(ok, 100));
    expect(sandboxAlerts.length).toBeLessThanOrEqual(6);
  });
});
