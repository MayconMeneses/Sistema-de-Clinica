import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { signMercadoPago, verifyMercadoPago } from '../src/integrations/payments/webhook.js';
import { mapStatus } from '../src/integrations/payments/mercadopago.js';
import { sandboxReset } from '../src/integrations/payments/sandbox.js';
import { intentIdFor } from '../src/modules/payments/service.js';

// ---------------------------------------------------------------- Mercado Pago FALSO (servidor HTTP local; nada sai da máquina)
interface FakePayment { id: number; status: string; status_detail?: string; transaction_amount: number; external_reference: string; payment_method_id: string; payment_type_id: string; transaction_amount_refunded: number }
const TOKEN = 'APP_USR-token-de-teste-1234567890';
const fake = { payments: new Map<number, FakePayment>(), calls: [] as { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any }[], next: 1000, failCreate: 0, forceAmount: null as number | null };
let server: Server; let base = '';

function read(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => { const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); } }); });
}
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await read(req);
    fake.calls.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const send = (code: number, json: object) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'invalid token' });
    const url = new URL(req.url!, 'http://x');
    if (req.method === 'POST' && url.pathname === '/v1/payments') {
      if (fake.failCreate === 401) { fake.failCreate = 0; return send(401, {}); }
      if (fake.failCreate === 500) { fake.failCreate = 0; return send(500, {}); }
      const id = ++fake.next;
      const p: FakePayment = { id, status: 'pending', transaction_amount: body.transaction_amount, external_reference: body.external_reference, payment_method_id: 'pix', payment_type_id: 'bank_transfer', transaction_amount_refunded: 0 };
      fake.payments.set(id, p);
      return send(201, { ...p, point_of_interaction: { transaction_data: { qr_code: `0002012658FAKE${id}`, qr_code_base64: 'iVBORw0KGgo=' } } });
    }
    if (req.method === 'POST' && url.pathname === '/checkout/preferences') {
      const id = ++fake.next;
      // o pagamento do link só existe depois que o paciente paga: guardamos a referência para o teste "pagar" depois
      fake.payments.set(id, { id, status: 'pending', transaction_amount: body.items[0].unit_price, external_reference: body.external_reference, payment_method_id: 'visa', payment_type_id: 'credit_card', transaction_amount_refunded: 0 });
      return send(201, { id: `pref-${id}`, init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-${id}` });
    }
    const m = /^\/v1\/payments\/(\d+)(\/refunds)?$/.exec(url.pathname);
    if (m) {
      const p = fake.payments.get(Number(m[1]));
      if (!p) return send(404, { message: 'not found' });
      if (req.method === 'GET') return send(200, fake.forceAmount !== null ? { ...p, transaction_amount: fake.forceAmount } : p);
      if (req.method === 'PUT') { if (p.status === 'approved') return send(400, { message: 'cannot cancel approved' }); p.status = 'cancelled'; return send(200, p); }
      if (req.method === 'POST' && m[2]) {
        const amount = body.amount ?? (p.transaction_amount - p.transaction_amount_refunded);
        if (amount <= 0 || amount > p.transaction_amount - p.transaction_amount_refunded + 1e-9) return send(400, { message: 'invalid refund amount' });
        p.transaction_amount_refunded = Math.round((p.transaction_amount_refunded + amount) * 100) / 100;
        if (p.transaction_amount_refunded >= p.transaction_amount) p.status = 'refunded';
        return send(201, { id: 1 });
      }
    }
    if (req.method === 'GET' && url.pathname === '/v1/payments/search') {
      const ref = url.searchParams.get('external_reference');
      return send(200, { results: [...fake.payments.values()].filter((p) => p.external_reference === ref) });
    }
    return send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.MERCADOPAGO_API_BASE = base;
  process.env.PUBLIC_BASE_URL = 'https://clinica.exemplo.com.br/';
});
afterAll(async () => { await new Promise((r) => server.close(r)); delete process.env.MERCADOPAGO_API_BASE; delete process.env.PUBLIC_BASE_URL; });

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');
let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

type T = Awaited<ReturnType<typeof tenant>>;
let seq = 0;
const key = () => `pay-key-${Date.now()}-${seq++}`;
const SECRET = 'segredo-do-webhook-123';

async function liveClinic(label: string) {
  const t = await tenant(label);
  const r = await t.owner.req('PUT', '/api/payments/settings', { mode: 'live', accessToken: TOKEN, webhookSecret: SECRET });
  expect(r.statusCode).toBe(200);
  return t;
}
async function patient(t: T, extra: object = {}) {
  const pid = (await t.owner.post('/api/patients', { name: `Paciente Pagamento ${seq++}`, email: 'paciente@exemplo.com', ...extra })).json().id as string;
  expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'charge', amountCents: 20000 })).statusCode).toBe(200);
  return pid;
}
const balance = async (t: T, pid: string) => (await t.owner.get(`/api/patients/${pid}/finance`)).json().balanceCents as string;
const newIntent = (t: T, patientId: string, extra: object = {}) => t.owner.post('/api/payments/intents', { patientId, amountCents: 15050, method: 'pix', idempotencyKey: key(), ...extra });
function webhook(tenantId: string, paymentId: number | string, opts: { secret?: string; ts?: string; type?: string; sign?: boolean } = {}) {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const requestId = `req-${seq++}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-request-id': requestId };
  if (opts.sign !== false) headers['x-signature'] = signMercadoPago(opts.secret ?? SECRET, { dataId: String(paymentId), requestId, ts });
  return app.inject({ method: 'POST', url: `/api/webhooks/mercadopago/${tenantId}?data.id=${paymentId}&type=${opts.type ?? 'payment'}`, headers, payload: JSON.stringify({ type: opts.type ?? 'payment', data: { id: String(paymentId) } }) });
}
const pay = (p: FakePayment) => { p.status = 'approved'; };

describe('verificação de assinatura do webhook', () => {
  const now = Date.now(); const ts = String(Math.floor(now / 1000));
  it('aceita a assinatura correta e recusa adulteração, segredo errado, janela vencida e formato inválido', () => {
    const sig = signMercadoPago('s3gredo-teste', { dataId: 'ABC123', requestId: 'r-1', ts });
    expect(verifyMercadoPago('s3gredo-teste', { signature: sig, requestId: 'r-1', dataId: 'abc123' }, now)).toBe(true);   // id em minúsculas
    expect(verifyMercadoPago('s3gredo-teste', { signature: sig, requestId: 'r-1', dataId: 'outro' }, now)).toBe(false);
    expect(verifyMercadoPago('s3gredo-teste', { signature: sig, requestId: 'r-2', dataId: 'abc123' }, now)).toBe(false);
    expect(verifyMercadoPago('outro-segredo', { signature: sig, requestId: 'r-1', dataId: 'abc123' }, now)).toBe(false);
    expect(verifyMercadoPago('s3gredo-teste', { signature: sig, requestId: 'r-1', dataId: 'abc123' }, now + 11 * 60_000)).toBe(false);
    expect(verifyMercadoPago('s3gredo-teste', { requestId: 'r-1', dataId: 'abc123' }, now)).toBe(false);
    expect(verifyMercadoPago('s3gredo-teste', { signature: 'ts=abc,v1=zzz', requestId: 'r-1', dataId: 'abc123' }, now)).toBe(false);
    expect(verifyMercadoPago('s3gredo-teste', { signature: `ts=${ts}`, requestId: 'r-1', dataId: 'abc123' }, now)).toBe(false);
  });
  it('sem data.id na consulta o texto assinado omite o id; status do provedor é normalizado; id da cobrança é derivado da chave', () => {
    const sig = signMercadoPago('seg-teste-12', { requestId: 'r-9', ts });
    expect(verifyMercadoPago('seg-teste-12', { signature: sig, requestId: 'r-9' }, now)).toBe(true);
    expect([mapStatus('approved'), mapStatus('in_process'), mapStatus('cancelled', 'expired'), mapStatus('cancelled'), mapStatus('charged_back'), mapStatus('rejected')])
      .toEqual(['approved', 'pending', 'expired', 'cancelled', 'refunded', 'rejected']);
    const a = intentIdFor('11111111-1111-4111-8111-111111111111', 'k1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(intentIdFor('11111111-1111-4111-8111-111111111111', 'k1')).toBe(a);
    expect(intentIdFor('11111111-1111-4111-8111-111111111111', 'k2')).not.toBe(a);
    expect(intentIdFor('22222222-2222-4222-8222-222222222222', 'k1')).not.toBe(a);
  });
});

describe('configuração de pagamentos', () => {
  it('exige o recurso no plano e perfil adequado; credenciais nunca saem e ficam cifradas', async () => {
    const e = await tenant('payplan', 'essencial');
    expect((await e.owner.get('/api/payments/settings')).json().error).toBe('capability_unavailable');
    const t = await tenant('paycfg');
    const rec = await t.mk('receptionist', 'rita');
    expect((await rec.c.get('/api/payments/settings')).statusCode).toBe(403);
    expect((await t.owner.req('PUT', '/api/payments/settings', { mode: 'live' })).statusCode).toBe(400);                       // produção exige o token
    expect((await t.owner.req('PUT', '/api/payments/settings', { accessToken: 'curto' })).statusCode).toBe(400);
    expect((await t.owner.get('/api/payments/settings')).json()).toMatchObject({ mode: 'sandbox', tokenConfigured: false }); // padrão de desenvolvimento
    expect((await t.owner.req('PUT', '/api/payments/settings', { mode: 'live', accessToken: TOKEN, webhookSecret: SECRET })).statusCode).toBe(200);
    const s = (await t.owner.get('/api/payments/settings')).json();
    expect(s).toMatchObject({ mode: 'live', tokenConfigured: true, tokenLast4: TOKEN.slice(-4), webhookSecretConfigured: true, publicBaseUrlConfigured: true });
    expect(s.notificationUrl).toBe(`https://clinica.exemplo.com.br/api/webhooks/mercadopago/${t.id}`);
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(JSON.stringify(s)).not.toContain(SECRET);
    const row = (await withTenant(appPool, t.id, (tx) => tx.query('SELECT access_token_enc, webhook_secret_enc FROM payment_settings'))).rows[0];
    expect(row.access_token_enc).toMatch(/^v2:/);
    expect(row.access_token_enc).not.toContain(TOKEN);
    expect(row.webhook_secret_enc).toMatch(/^v2:/);
    // trocar só o modo mantém as credenciais; apagar remove
    expect((await t.owner.req('PUT', '/api/payments/settings', { mode: 'disabled' })).statusCode).toBe(200);
    expect((await t.owner.get('/api/payments/settings')).json()).toMatchObject({ mode: 'disabled', tokenConfigured: true });
    expect((await t.owner.req('PUT', '/api/payments/settings', { mode: 'sandbox', clearCredentials: true })).statusCode).toBe(200);
    expect((await t.owner.get('/api/payments/settings')).json()).toMatchObject({ tokenConfigured: false, webhookSecretConfigured: false });
    // clínica com pagamentos desligados não cobra
    await t.owner.req('PUT', '/api/payments/settings', { mode: 'disabled' });
    const pid = await patient(t);
    expect((await newIntent(t, pid)).json().error).toBe('payments_disabled');
  });
});

describe('cobrança online no sandbox (sem rede)', () => {
  it('Pix: cria, simula o pagamento, concilia uma vez com recibo, estorna com perfil autorizado; link de pagamento também', async () => {
    sandboxReset();
    const t = await tenant('paysbx');
    const rec = await t.mk('receptionist', 'rita');
    const pid = await patient(t, { email: null });
    expect((await newIntent(t, pid)).statusCode).toBe(400);                                   // Pix exige e-mail do pagador
    expect((await newIntent(t, pid, { payerEmail: 'a@b.com', amountCents: 50 })).statusCode).toBe(400); // mínimo R$ 1,00
    const k = key();
    const created = (await newIntent(t, pid, { payerEmail: 'pagador@exemplo.com', idempotencyKey: k })).json();
    expect(created).toMatchObject({ status: 'pending', method: 'pix', provider: 'sandbox', amountCents: '15050', duplicate: false });
    expect(created.pixQrCode).toContain('SANDBOX');
    const again = (await newIntent(t, pid, { payerEmail: 'pagador@exemplo.com', idempotencyKey: k })).json();
    expect(again).toMatchObject({ id: created.id, duplicate: true });                         // mesma chave, mesma cobrança
    expect((await t.owner.get('/api/payments/intents?status=pending')).json().intents).toHaveLength(1);

    expect((await rec.c.post(`/api/payments/intents/${created.id}/sandbox-approve`)).statusCode).toBe(200);
    const paid = (await t.owner.get('/api/payments/intents')).json().intents[0];
    expect(paid).toMatchObject({ status: 'approved', paidMethod: 'pix', receiptNumber: 1 });
    expect(await balance(t, pid)).toBe('4950');                                               // 200,00 − 150,50
    expect((await t.owner.post(`/api/payments/intents/${created.id}/sync`)).json().status).toBe('approved');
    expect(await balance(t, pid)).toBe('4950');                                               // verificar de novo não paga duas vezes
    expect((await t.owner.post(`/api/payments/intents/${created.id}/cancel`)).statusCode).toBe(409);

    expect((await rec.c.post(`/api/payments/intents/${created.id}/refund`, { reason: 'Paciente desistiu' })).statusCode).toBe(403); // estorno é com aprovador
    expect((await t.owner.post(`/api/payments/intents/${created.id}/refund`, { reason: 'x' })).statusCode).toBe(400);
    expect((await t.owner.post(`/api/payments/intents/${created.id}/refund`, { reason: 'Paciente desistiu' })).json().status).toBe('refunded');
    expect(await balance(t, pid)).toBe('20000');
    expect((await t.owner.post(`/api/payments/intents/${created.id}/refund`, { reason: 'Paciente desistiu' })).statusCode).toBe(409);

    // link de pagamento (cartão): sem e-mail obrigatório; id do pagamento surge ao pagar
    const link = (await newIntent(t, pid, { method: 'link', amountCents: 5000 })).json();
    expect(link.checkoutUrl).toMatch(/^https:\/\/sandbox\.invalid\/checkout\//);
    await t.owner.post(`/api/payments/intents/${link.id}/sandbox-approve`);
    expect((await t.owner.get('/api/payments/intents?status=approved')).json().intents[0]).toMatchObject({ method: 'link', paidMethod: 'card', receiptNumber: 2 });

    const audit = ((await t.owner.get('/api/audit')).json().events as { action: string }[]).map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['payment.create', 'payment.approved', 'payment.refund', 'payment.refunded']));
  });

  it('cancelar cobrança pendente; o banco protege valor e histórico', async () => {
    sandboxReset();
    const t = await tenant('paycancel');
    const pid = await patient(t);
    const c = (await newIntent(t, pid)).json();
    expect((await t.owner.post(`/api/payments/intents/${c.id}/cancel`)).json().status).toBe('cancelled');
    expect((await t.owner.post(`/api/payments/intents/${c.id}/sandbox-approve`)).statusCode).toBe(409); // cancelada não é paga depois
    const run = (sql: string) => withTenant(appPool, t.id, (tx) => tx.query(sql));
    await expect(run('UPDATE payment_intents SET amount_cents = 100')).rejects.toThrow(/imutáveis|imutável/);
    await expect(run('DELETE FROM payment_intents')).rejects.toThrow(/permission denied|excluída/);
    await expect(run("UPDATE payment_intents SET status = 'approved'")).rejects.toThrow(/transição|imutável|check/i);
  });
});

describe('cobrança online com o Mercado Pago (servidor falso)', () => {
  it('Pix: a requisição segue o formato do provedor e o pagamento confirmado por webhook assinado entra uma única vez', async () => {
    const t = await liveClinic('paylive');
    const pid = await patient(t);
    fake.calls.length = 0;
    const created = (await newIntent(t, pid)).json();
    expect(created).toMatchObject({ status: 'pending', provider: 'mercadopago', method: 'pix' });
    expect(created.pixQrCode).toMatch(/^0002012658FAKE/);

    const call = fake.calls.find((c) => c.method === 'POST' && c.url === '/v1/payments')!;
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers['x-idempotency-key']).toBe(created.id);
    expect(call.body).toMatchObject({ transaction_amount: 150.5, payment_method_id: 'pix', external_reference: created.id, payer: { email: 'paciente@exemplo.com' } });
    expect(call.body.notification_url).toBe(`https://clinica.exemplo.com.br/api/webhooks/mercadopago/${t.id}`);
    expect(call.body.date_of_expiration).toMatch(/-03:00$/);

    const providerId = [...fake.payments.values()].find((p) => p.external_reference === created.id)!;
    // notificação ANTES do pagamento: nada muda; com assinatura inválida: recusada
    expect((await webhook(t.id, providerId.id)).statusCode).toBe(200);
    expect(await balance(t, pid)).toBe('20000');
    expect((await webhook(t.id, providerId.id, { secret: 'segredo-errado' })).statusCode).toBe(401);
    expect((await webhook(t.id, providerId.id, { sign: false })).statusCode).toBe(401);
    expect((await webhook(t.id, providerId.id, { ts: String(Math.floor(Date.now() / 1000) - 3600) })).statusCode).toBe(401);

    pay(providerId);
    const [w1, w2] = await Promise.all([webhook(t.id, providerId.id), webhook(t.id, providerId.id)]);   // entrega repetida/simultânea
    expect([w1.statusCode, w2.statusCode]).toEqual([200, 200]);
    expect(await balance(t, pid)).toBe('4950');
    const movs = (await t.owner.get(`/api/patients/${pid}/finance`)).json().movements as { kind: string; method: string; receiptNumber: number | null }[];
    expect(movs.filter((m) => m.kind === 'payment')).toHaveLength(1);
    expect(movs.find((m) => m.kind === 'payment')).toMatchObject({ method: 'pix', receiptNumber: 1 });
    expect((await t.owner.get('/api/payments/intents?status=approved')).json().intents).toHaveLength(1);
    expect((await webhook(t.id, providerId.id)).statusCode).toBe(200);
    expect(await balance(t, pid)).toBe('4950');
  });

  it('webhook: tipo diferente, clínica desconhecida/sem segredo e segredo de outra clínica não passam', async () => {
    const a = await liveClinic('paywha');
    const b = await liveClinic('paywhb');
    await b.owner.req('PUT', '/api/payments/settings', { webhookSecret: 'outro-segredo-da-b' });
    const pid = await patient(a);
    const c = (await newIntent(a, pid)).json();
    const p = [...fake.payments.values()].find((x) => x.external_reference === c.id)!;
    pay(p);
    expect((await webhook(a.id, p.id, { type: 'merchant_order' })).json()).toEqual({ ignored: true });
    expect(await balance(a, pid)).toBe('20000');
    expect((await webhook(b.id, p.id)).statusCode).toBe(401);                                          // segredo da A na rota da B
    expect((await webhook('00000000-0000-4000-8000-000000000000', p.id)).statusCode).toBe(503);        // clínica inexistente: mesma resposta de "não configurado"
    const sandboxClinic = await tenant('paywhs');
    expect((await webhook(sandboxClinic.id, p.id)).statusCode).toBe(503);
    expect((await webhook(b.id, p.id, { secret: 'outro-segredo-da-b' })).statusCode).toBe(200);        // assinatura certa da B, mas o pagamento não é da B
    expect(await balance(a, pid)).toBe('20000');                                                      // e a cobrança da A não foi tocada
    expect((await webhook(a.id, p.id)).statusCode).toBe(200);
    expect(await balance(a, pid)).toBe('4950');
  });

  it('valor ou referência divergentes não confirmam a cobrança; ficam na auditoria', async () => {
    const t = await liveClinic('paymis');
    const pid = await patient(t);
    const c = (await newIntent(t, pid)).json();
    const p = [...fake.payments.values()].find((x) => x.external_reference === c.id)!;
    pay(p);
    fake.forceAmount = 1.0;
    expect((await t.owner.post(`/api/payments/intents/${c.id}/sync`)).json().status).toBe('pending');
    fake.forceAmount = null;
    p.external_reference = 'outra-referencia-qualquer';                                              // pagamento que aponta para outra referência
    expect((await t.owner.post(`/api/payments/intents/${c.id}/sync`)).json().status).toBe('pending');
    expect(await balance(t, pid)).toBe('20000');
    const audit = ((await t.owner.get('/api/audit')).json().events as { action: string }[]).map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['payment.amount_mismatch', 'payment.reference_mismatch']));
  });

  it('erros do provedor viram mensagens claras e nada fica gravado; repetir a mesma chave depois funciona', async () => {
    const t = await liveClinic('payerr');
    const pid = await patient(t);
    const k = key();
    fake.failCreate = 401;
    const bad = await newIntent(t, pid, { idempotencyKey: k });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error).toBe('gateway_credentials');
    expect(bad.json().message).toMatch(/Access Token/);
    expect(JSON.stringify(bad.json())).not.toContain(TOKEN);
    fake.failCreate = 500;
    expect((await newIntent(t, pid, { idempotencyKey: k })).json().error).toBe('gateway_unavailable');
    expect((await t.owner.get('/api/payments/intents')).json().intents).toHaveLength(0);
    expect((await newIntent(t, pid, { idempotencyKey: k })).statusCode).toBe(200);                      // mesma chave, agora com sucesso
    // token revogado depois de configurado
    await t.owner.req('PUT', '/api/payments/settings', { accessToken: 'APP_USR-token-revogado-9999' });
    expect((await newIntent(t, pid)).json().error).toBe('gateway_credentials');
  });

  it('link de pagamento: preferência criada; "Verificar" acha o pagamento pela referência; estorno pelo provedor reflete no financeiro', async () => {
    const t = await liveClinic('paylink');
    const pid = await patient(t);
    const c = (await newIntent(t, pid, { method: 'link', amountCents: 7000 })).json();
    expect(c.checkoutUrl).toMatch(/^https:\/\/www\.mercadopago\.com\.br\//);
    const pref = fake.calls.find((x) => x.url === '/checkout/preferences' && x.body.external_reference === c.id)!;
    expect(pref.body.items[0]).toMatchObject({ quantity: 1, unit_price: 70, currency_id: 'BRL' });
    expect((await t.owner.post(`/api/payments/intents/${c.id}/sync`)).json().status).toBe('pending');
    const p = [...fake.payments.values()].find((x) => x.external_reference === c.id)!;
    pay(p);
    const paid = (await t.owner.post(`/api/payments/intents/${c.id}/sync`)).json();
    expect(paid).toMatchObject({ status: 'approved', paidMethod: 'card' });
    expect(await balance(t, pid)).toBe('13000');
    // estorno feito direto no painel do Mercado Pago chega por webhook e vira UM movimento de estorno
    p.status = 'refunded'; p.transaction_amount_refunded = p.transaction_amount;
    expect((await webhook(t.id, p.id)).statusCode).toBe(200);
    expect((await webhook(t.id, p.id)).statusCode).toBe(200);
    expect(await balance(t, pid)).toBe('20000');
    expect((await t.owner.get(`/api/payments/intents?patientId=${pid}`)).json().intents[0].status).toBe('refunded');
    const movs = (await t.owner.get(`/api/patients/${pid}/finance`)).json().movements as { kind: string }[];
    expect(movs.filter((m) => m.kind === 'refund')).toHaveLength(1);
  });

  it('parcelamento: o link limita as parcelas no provedor; só vale para link e com parcela mínima de R$ 5,00', async () => {
    const t = await liveClinic('payinstall');
    const pid = await patient(t);
    const c = await newIntent(t, pid, { method: 'link', amountCents: 12000, maxInstallments: 6 });
    expect(c.statusCode).toBe(200);
    expect(c.json().maxInstallments).toBe(6);
    const pref = fake.calls.find((x) => x.url === '/checkout/preferences' && x.body.external_reference === c.json().id)!;
    expect(pref.body.payment_methods).toEqual({ installments: 6 });
    const avista = (await newIntent(t, pid, { method: 'link', amountCents: 12000 })).json();
    const pref1 = fake.calls.find((x) => x.url === '/checkout/preferences' && x.body.external_reference === avista.id)!;
    expect(pref1.body.payment_methods).toBeUndefined();
    expect(avista.maxInstallments).toBe(1);
    expect((await newIntent(t, pid, { method: 'pix', maxInstallments: 3 })).statusCode).toBe(400);
    expect((await newIntent(t, pid, { method: 'link', amountCents: 1000, maxInstallments: 3 })).statusCode).toBe(400); // R$ 3,33 por parcela
    expect((await newIntent(t, pid, { method: 'link', amountCents: 12000, maxInstallments: 13 })).statusCode).toBe(400);
    const list = (await t.owner.get(`/api/payments/intents?patientId=${pid}`)).json().intents as { id: string; maxInstallments: number }[];
    expect(list.find((i) => i.id === c.json().id)?.maxInstallments).toBe(6);
  });

  it('estorno e cancelamento pela API chamam o provedor; pagamento feito no meio do cancelamento prevalece', async () => {
    const t = await liveClinic('payrefund');
    const pid = await patient(t);
    const a = (await newIntent(t, pid)).json();
    const pa = [...fake.payments.values()].find((x) => x.external_reference === a.id)!;
    pay(pa);
    await t.owner.post(`/api/payments/intents/${a.id}/sync`);
    fake.calls.length = 0;
    expect((await t.owner.post(`/api/payments/intents/${a.id}/refund`, { reason: 'Atendimento não realizado' })).json().status).toBe('refunded');
    const refundCall = fake.calls.find((x) => x.method === 'POST' && x.url === `/v1/payments/${pa.id}/refunds`)!;
    expect(refundCall.headers['x-idempotency-key']).toBe(`refund-${a.id}`);
    expect(await balance(t, pid)).toBe('20000');

    const b = (await newIntent(t, pid)).json();
    const pb = [...fake.payments.values()].find((x) => x.external_reference === b.id)!;
    pb.status = 'approved';                                                                          // o paciente pagou antes de a recepção cancelar
    const cancel = await t.owner.post(`/api/payments/intents/${b.id}/cancel`);
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ status: 'approved' });
    expect(cancel.json().notice).toMatch(/já foi confirmado/);
    expect((await t.owner.get(`/api/payments/intents?patientId=${pid}`)).json().intents.find((i: { id: string }) => i.id === b.id).status).toBe('approved');
    expect(await balance(t, pid)).toBe('4950');
  });

  it('cobranças e configuração de uma clínica não aparecem nem agem em outra', async () => {
    const a = await liveClinic('payisoa');
    const b = await liveClinic('payisob');
    const pid = await patient(a);
    const c = (await newIntent(a, pid)).json();
    expect((await b.owner.get('/api/payments/intents')).json().intents).toHaveLength(0);
    expect((await b.owner.post(`/api/payments/intents/${c.id}/sync`)).statusCode).toBe(404);
    expect((await b.owner.post(`/api/payments/intents/${c.id}/cancel`)).statusCode).toBe(404);
    expect((await b.owner.post(`/api/payments/intents/${c.id}/refund`, { reason: 'Tentativa indevida' })).statusCode).toBe(404);
    expect((await b.owner.post('/api/payments/intents', { patientId: pid, amountCents: 1000, method: 'pix', idempotencyKey: key() })).statusCode).toBe(400); // paciente de outra clínica
  });
});

describe('estorno parcial', () => {
  async function paid(label: string) {
    const t = await liveClinic(label);
    const pid = await patient(t);
    const a = (await newIntent(t, pid)).json();
    const pa = [...fake.payments.values()].find((x) => x.external_reference === a.id)!;
    pay(pa);
    await t.owner.post(`/api/payments/intents/${a.id}/sync`);
    return { t, pid, a, pa };
  }
  const refund = (t: Awaited<ReturnType<typeof liveClinic>>, id: string, body: object) => t.owner.post(`/api/payments/intents/${id}/refund`, { reason: 'Procedimento reduzido', ...body });

  it('devolve parte, mantém a cobrança como paga e só vira estornada quando a soma fecha o valor', async () => {
    const { t, pid, a, pa } = await paid('payrefpart');
    const total = Number(a.amountCents);                                                // 15050
    const base = Number(await balance(t, pid));                                         // o que ainda estava em aberto depois do pagamento
    fake.calls.length = 0;
    const r1 = await refund(t, a.id, { amountCents: 5000 });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ status: 'approved', refundedCents: '5000', notice: 'Estorno parcial registrado.' });
    const call = fake.calls.find((x) => x.url === `/v1/payments/${pa.id}/refunds`)!;
    expect(call.body).toEqual({ amount: 50 });                                          // em reais, só a parte
    expect(call.headers['x-idempotency-key']).toBe(`refund-${a.id}-0-5000`);
    expect(await balance(t, pid)).toBe(String(base + 5000));                           // devolvido vira saldo a receber de novo

    // mais que o restante: recusa; segundo parcial; o resto fecha
    expect((await refund(t, a.id, { amountCents: total })).statusCode).toBe(400);
    expect((await refund(t, a.id, { amountCents: 2000 })).json()).toMatchObject({ status: 'approved', refundedCents: '7000' });
    const last = await refund(t, a.id, {});                                             // sem valor = o que resta
    expect(last.json()).toMatchObject({ status: 'refunded', refundedCents: String(total) });
    expect(await balance(t, pid)).toBe(String(base + total));
    const movs = (await t.owner.get(`/api/patients/${pid}/finance`)).json().movements as { kind: string; amountCents: string }[];
    expect(movs.filter((m) => m.kind === 'refund').map((m) => m.amountCents).sort()).toEqual(['2000', '5000', String(total - 7000)].sort());
    expect((await refund(t, a.id, { amountCents: 100 })).statusCode).toBe(409);        // já estornada por inteiro
  });

  it('repetir o pedido ou sincronizar não devolve duas vezes; estorno feito direto no painel do provedor é conciliado', async () => {
    const { t, pid, a, pa } = await paid('payrefsync');
    const base = Number(await balance(t, pid));
    await refund(t, a.id, { amountCents: 3000 });
    await t.owner.post(`/api/payments/intents/${a.id}/sync`);
    await t.owner.post(`/api/payments/intents/${a.id}/sync`);
    expect(await balance(t, pid)).toBe(String(base + 3000));
    // a clínica devolveu mais 4000 direto no painel do Mercado Pago
    pa.transaction_amount_refunded = 70; // R$ 30 + R$ 40
    const s = await t.owner.post(`/api/payments/intents/${a.id}/sync`);
    expect(s.json()).toMatchObject({ status: 'approved', refundedCents: '7000' });
    expect(await balance(t, pid)).toBe(String(base + 7000));
    const rows = await withTenant(appPool, t.id, (tx) => tx.query("SELECT amount_cents::text, cumulative_cents::text FROM payment_refunds WHERE intent_id = $1 ORDER BY cumulative_cents", [a.id]));
    expect(rows.rows).toEqual([{ amount_cents: '3000', cumulative_cents: '3000' }, { amount_cents: '4000', cumulative_cents: '7000' }]);
  });

  it('banco: valor devolvido nunca diminui nem passa do pago; histórico de devoluções é imutável', async () => {
    const { t, a } = await paid('payrefdb');
    await refund(t, a.id, { amountCents: 1000 });
    const run = (sql: string) => withTenant(appPool, t.id, (tx) => tx.query(sql));
    await expect(run('UPDATE payment_intents SET refunded_cents = 0')).rejects.toThrow(/não pode diminuir/);
    await expect(run('UPDATE payment_intents SET refunded_cents = amount_cents + 1')).rejects.toThrow(/refunded_range|check/i);
    await expect(run('UPDATE payment_refunds SET amount_cents = 1')).rejects.toThrow(/permission denied|append-only/);
    await expect(run('DELETE FROM payment_refunds')).rejects.toThrow(/permission denied|append-only/);
  });
});
