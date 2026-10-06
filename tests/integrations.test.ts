import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { LocalFsStorage } from '../src/integrations/storage.js';
import { httpJson } from '../src/integrations/http.js';
import { EmailHttpAdapter, WhatsAppCloudAdapter } from '../src/integrations/providers.js';
import { setAdapterOverride } from '../src/integrations/registry.js';
import { sandboxSent } from '../src/integrations/sandbox.js';
import { AdapterError } from '../src/integrations/types.js';
import { enqueueAppointmentMessages } from '../src/modules/communications/enqueue.js';
import { sanitizeError } from '../src/modules/communications/handler.js';
import { backoffMs, processOutbox } from '../src/worker/outbox.js';
import { processReceipts } from '../src/worker/receipts.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { Client, tenant, master, state, PW } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });
afterEach(() => { setAdapterOverride(null); delete process.env.WEBHOOK_SECRET_GENERIC; delete process.env.WHATSAPP_APP_SECRET; delete process.env.WHATSAPP_VERIFY_TOKEN; });
// TOTP do Master: começar cada teste na primeira parte do passo de 30s (ver api.test.ts).
beforeEach(async () => { const pos = Date.now() % 30000; if (pos > 25000) await new Promise((r) => setTimeout(r, 30000 - pos + 300)); });

const drain = async () => { for (let i = 0; i < 8; i++) if (!(await processOutbox({ workerPool, appPool, batch: 200 })).claimed) break; };

async function clinic(plan = 'completa', patient: { phone?: string | null; email?: string | null } = { phone: '+5511988887777', email: 'paciente@exemplo.com' }) {
  const t = await tenant('int', plan);
  await t.mk('professional', 'dr');
  const proId = ((await t.owner.get('/api/professionals')).json().professionals as { id: string }[])[0]!.id;
  const pid = (await t.owner.post('/api/patients', { name: 'Paciente Integra', ...patient })).json().id as string;
  let slot = 0;
  const book = (patientId = pid, startsAt?: string) => {
    const start = startsAt ?? new Date(Date.UTC(2031, 5, 1, 12 + slot++, 0)).toISOString();
    return t.owner.post('/api/appointments', { patientId, professionalId: proId, startsAt: start, endsAt: new Date(new Date(start).getTime() + 3000_000).toISOString() });
  };
  const consent = (purpose = 'communication_whatsapp', granted = true, patientId = pid) => t.owner.post(`/api/patients/${patientId}/consents`, { purpose, granted });
  const events = async (patientId = pid) =>
    (await workerPool.query(`SELECT id, status, delivery_status, last_error, attempts, max_attempts, external_id, payload, next_attempt_at FROM outbox_events WHERE tenant_id = $1 AND payload->>'patientId' = $2 ORDER BY created_at`, [t.id, patientId])).rows;
  const makeDue = (id: string) => workerPool.query('UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1', [id]);
  return { t, pid, proId, book, consent, events, makeDue };
}

describe('outbox transacional e consentimento', () => {
  it('sem consentimento nada é enviado e o motivo fica registrado', async () => {
    const c = await clinic();
    expect((await c.book()).statusCode).toBe(200);
    await drain();
    const ev = await c.events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ status: 'skipped', last_error: 'no_consent', external_id: null }); // nunca chegou ao provedor
  });

  it('com consentimento: confirmação sai pelo sandbox e o lembrete fica agendado para 24h antes', async () => {
    const c = await clinic();
    await c.consent();
    const startsAt = new Date(Date.UTC(2031, 5, 1, 12, 0)).toISOString();
    expect((await c.book(c.pid, startsAt)).statusCode).toBe(200);
    const queued = await c.events();
    expect(queued.map((e) => e.payload.template).sort()).toEqual(['appointment_confirmation', 'appointment_reminder']);
    const reminder = queued.find((e) => e.payload.template === 'appointment_reminder')!;
    expect(new Date(reminder.next_attempt_at).getTime()).toBe(new Date(startsAt).getTime() - 24 * 3600_000);
    await drain();
    const after = await c.events();
    const conf = after.find((e) => e.payload.template === 'appointment_confirmation')!;
    expect(conf.status).toBe('sent');
    expect(conf.external_id).toMatch(/^sandbox-/);
    expect(after.find((e) => e.payload.template === 'appointment_reminder')!.status).toBe('pending'); // ainda não venceu
    expect(sandboxSent.at(-1)).toMatchObject({ channel: 'whatsapp', templateName: 'appointment_confirmation' });
    expect(sandboxSent.at(-1)!.toMasked).not.toContain('88887777'); // destinatário mascarado
  });

  it('agendamento recusado (conflito) não enfileira mensagem: a outbox é atômica com a agenda', async () => {
    const c = await clinic();
    await c.consent();
    const slot = new Date(Date.UTC(2031, 6, 1, 12, 0)).toISOString();
    expect((await c.book(c.pid, slot)).statusCode).toBe(200);
    const other = (await c.t.owner.post('/api/patients', { name: 'Outro Paciente', phone: '+5511977776666' })).json().id as string;
    await c.consent('communication_whatsapp', true, other);
    expect((await c.book(other, slot)).statusCode).toBe(409);
    expect(await c.events(other)).toHaveLength(0);
  });

  it('mesma chave de idempotência não duplica o evento', async () => {
    const c = await clinic();
    await c.consent();
    const apptId = (await c.book()).json().id as string;
    const before = (await c.events()).length;
    await withTenant(appPool, c.t.id, (tx) =>
      enqueueAppointmentMessages({ tx, tenantId: c.t.id, entitlements: new Set(['communication.inbox']) }, { id: apptId, patientId: c.pid, startsAt: new Date(Date.UTC(2031, 5, 1, 12, 0)).toISOString() }, 'confirmation'));
    // o horário da consulta criada por book() é o primeiro slot: mesma chave => nenhuma linha nova
    expect((await c.events()).length).toBe(before);
  });

  it('consentimento revogado depois de enfileirar: o worker pula, não envia', async () => {
    const c = await clinic();
    await c.consent();
    await c.book();
    await c.consent('communication_whatsapp', false);
    await drain();
    const conf = (await c.events()).find((e) => e.payload.template === 'appointment_confirmation')!;
    expect(conf).toMatchObject({ status: 'skipped', last_error: 'no_consent', external_id: null });
  });

  it('consulta cancelada: lembrete vencido é pulado e o aviso de cancelamento é enviado', async () => {
    const c = await clinic();
    await c.consent();
    const apptId = (await c.book()).json().id as string;
    await drain();
    const reminder = (await c.events()).find((e) => e.payload.template === 'appointment_reminder')!;
    await c.makeDue(reminder.id);
    expect((await c.t.owner.patch(`/api/appointments/${apptId}`, { status: 'cancelled', reason: 'Paciente desistiu' })).statusCode).toBe(200);
    await drain();
    const ev = await c.events();
    expect(ev.find((e) => e.payload.template === 'appointment_reminder')).toMatchObject({ status: 'skipped', last_error: 'appointment_changed' });
    expect(ev.find((e) => e.payload.template === 'appointment_cancelled')!.status).toBe('sent');
  });

  it('reagendamento: lembrete antigo é pulado; novo lembrete e aviso são criados', async () => {
    const c = await clinic();
    await c.consent();
    const apptId = (await c.book()).json().id as string;
    await drain();
    const old = (await c.events()).find((e) => e.payload.template === 'appointment_reminder')!;
    const next = new Date(Date.UTC(2031, 5, 3, 15, 0));
    expect((await c.t.owner.patch(`/api/appointments/${apptId}`, { startsAt: next.toISOString(), endsAt: new Date(next.getTime() + 3000_000).toISOString() })).statusCode).toBe(200);
    await c.makeDue(old.id);
    await drain();
    const ev = await c.events();
    expect(ev.find((e) => e.id === old.id)).toMatchObject({ status: 'skipped', last_error: 'appointment_changed' });
    expect(ev.filter((e) => e.payload.template === 'appointment_reminder')).toHaveLength(2);
    expect(ev.find((e) => e.payload.template === 'appointment_rescheduled')!.status).toBe('sent');
  });

  it('plano sem comunicação não gera eventos; evento de outro tenant não alcança paciente alheio', async () => {
    const solo = await clinic('solo');
    await solo.book();
    expect(await solo.events()).toHaveLength(0);

    const a = await clinic();
    const b = await clinic();
    await withTenant(appPool, b.t.id, (tx) => tx.query(
      `INSERT INTO outbox_events (tenant_id, topic, payload, idempotency_key) VALUES ($1,'message.send',$2,'cross-1')`,
      [b.t.id, JSON.stringify({ channel: 'whatsapp', template: 'appointment_confirmation', patientId: a.pid })]));
    await drain();
    const r = await workerPool.query(`SELECT status, last_error FROM outbox_events WHERE tenant_id = $1 AND idempotency_key = 'cross-1'`, [b.t.id]);
    expect(r.rows[0]).toMatchObject({ status: 'dead' });
    expect(r.rows[0].last_error).toContain('patient_not_found');
  });
});

describe('worker: retry, backoff, dead-letter e concorrência', () => {
  it('falha transitória: backoff com jitter, nova tentativa e sucesso na 3ª', async () => {
    let calls = 0;
    setAdapterOverride(() => ({ provider: 'x', configured: () => true, send: async (m) => { if (++calls < 3) throw new AdapterError('indisponível', true, 'http_503'); return { externalId: `ok-${m.idempotencyKey}` }; } }));
    const c = await clinic();
    await c.consent();
    await c.book();
    await drain();
    let conf = (await c.events()).find((e) => e.payload.template === 'appointment_confirmation')!;
    expect(conf).toMatchObject({ status: 'failed', attempts: 1 });
    expect(conf.last_error).toContain('http_503');
    expect(new Date(conf.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 10_000); // 30s × (0,5–1,5)
    await drain(); // ainda não venceu: nada acontece
    expect(calls).toBe(1);
    await c.makeDue(conf.id); await drain();
    await c.makeDue(conf.id); await drain();
    conf = (await c.events()).find((e) => e.payload.template === 'appointment_confirmation')!;
    expect(conf).toMatchObject({ status: 'sent', attempts: 3, external_id: `ok-${conf.id}` });
  });

  it('falha definitiva vai direto para dead-letter; Master recoloca na fila (com MFA) e o envio ocorre', async () => {
    let reject = true;
    setAdapterOverride(() => ({ provider: 'x', configured: () => true, send: async () => { if (reject) throw new AdapterError('número inválido', false, 'http_400'); return { externalId: 'ok-1' }; } }));
    const c = await clinic();
    await c.consent();
    await c.book();
    await drain();
    const dead = (await c.events()).find((e) => e.payload.template === 'appointment_confirmation')!;
    expect(dead).toMatchObject({ status: 'dead', attempts: 1 });
    expect(dead.last_error).toContain('http_400');

    reject = false;
    const m = await master();
    expect((await m.c.post('/api/master/integrations/requeue', { tenantId: c.t.id, code: '000000', justification: 'provedor corrigido' })).statusCode).toBe(403);
    const rq = await m.c.post('/api/master/integrations/requeue', { tenantId: c.t.id, code: m.code(), justification: 'provedor corrigido' });
    expect(rq.statusCode).toBe(200);
    expect(rq.json().messages).toBe(1);
    await drain();
    expect((await c.events()).find((e) => e.id === dead.id)).toMatchObject({ status: 'sent' });
  });

  it('esgotadas as tentativas o evento vira dead-letter', async () => {
    setAdapterOverride(() => ({ provider: 'x', configured: () => true, send: async () => { throw new AdapterError('fora do ar', true, 'http_500'); } }));
    const c = await clinic();
    await c.consent();
    await c.book();
    await drain();
    const e0 = (await c.events()).find((e) => e.payload.template === 'appointment_confirmation')!;
    await workerPool.query('UPDATE outbox_events SET max_attempts = 2 WHERE id = $1', [e0.id]);
    await c.makeDue(e0.id); await drain();
    expect((await c.events()).find((e) => e.id === e0.id)).toMatchObject({ status: 'dead', attempts: 2 });
  });

  it('sandbox simula rejeição definitiva do destinatário', async () => {
    const c = await clinic('completa', { phone: '+5511990000000' });
    await c.consent();
    await c.book();
    await drain();
    const e = (await c.events()).find((x) => x.payload.template === 'appointment_confirmation')!;
    expect(e).toMatchObject({ status: 'dead' });
    expect(e.last_error).toContain('sandbox_rejected');
  });

  it('vários workers em paralelo enviam cada mensagem exatamente uma vez (SKIP LOCKED)', async () => {
    const sent: string[] = [];
    setAdapterOverride(() => ({ provider: 'x', configured: () => true, send: async (m) => { await new Promise((r) => setTimeout(r, 15)); sent.push(m.idempotencyKey); return { externalId: `ok-${m.idempotencyKey}` }; } }));
    const c = await clinic();
    await c.consent();
    for (let i = 0; i < 6; i++) expect((await c.book()).statusCode).toBe(200);
    const mine = new Set((await c.events()).filter((e) => e.payload.template === 'appointment_confirmation').map((e) => e.id));
    expect(mine.size).toBe(6);
    await Promise.all([1, 2, 3].map(() => processOutbox({ workerPool, appPool, batch: 200 })));
    await drain();
    const mineSent = sent.filter((id) => mine.has(id));
    expect(mineSent).toHaveLength(6);
    expect(new Set(mineSent).size).toBe(6);
  });

  it('evento "processing" com lock vencido (worker caiu) é retomado', async () => {
    const c = await clinic();
    await c.consent();
    await c.book();
    const e0 = (await c.events()).find((e) => e.payload.template === 'appointment_confirmation')!;
    await workerPool.query(`UPDATE outbox_events SET status = 'processing', locked_until = now() - interval '1 minute' WHERE id = $1`, [e0.id]);
    await drain();
    expect((await c.events()).find((e) => e.id === e0.id)!.status).toBe('sent');
  });

  it('backoffMs cresce, tem teto de 1h e jitter de ±50%; erros são sanitizados', () => {
    for (let a = 1; a <= 12; a++) {
      const lo = backoffMs(a, () => 0), hi = backoffMs(a, () => 1);
      expect(lo).toBeLessThanOrEqual(hi);
      expect(hi).toBeLessThanOrEqual(3_600_000 * 1.5);
    }
    expect(backoffMs(2, () => 0.5)).toBe(2 * backoffMs(1, () => 0.5));
    const s = sanitizeError('falha para +5511988887777 e maria@clinica.com.br');
    expect(s).not.toMatch(/5511988887777|maria@/);
  });
});

describe('painel da plataforma e privilégios', () => {
  it('Master define o modo por clínica; "live" sem credenciais é recusado; "disabled" faz o worker pular', async () => {
    const c = await clinic();
    await c.consent();
    const m = await master();
    const live = await m.c.post(`/api/master/tenants/${c.t.id}/integrations`, { kind: 'whatsapp', mode: 'live', justification: 'ativar produção' });
    expect(live.statusCode).toBe(409);
    expect((await m.c.post(`/api/master/tenants/${c.t.id}/integrations`, { kind: 'whatsapp', mode: 'disabled', justification: 'pausa solicitada' })).statusCode).toBe(200);
    await c.book();
    await drain();
    expect((await c.events()).find((e) => e.payload.template === 'appointment_confirmation')).toMatchObject({ status: 'skipped', last_error: 'integration_disabled' });
    const ov = (await m.c.get('/api/master/integrations')).json();
    expect(ov.providers.find((p: { kind: string }) => p.kind === 'whatsapp')).toMatchObject({ configured: false, validatedWithProvider: false });
    expect(JSON.stringify(ov)).not.toMatch(/paciente|5511988887777/i);
  });

  it('Master vê só metadados da fila (sem conteúdo) e o runtime da clínica não altera a fila', async () => {
    await expect(platformPool.query('SELECT payload FROM outbox_events')).rejects.toThrow(/permission denied/);
    await expect(platformPool.query("UPDATE outbox_events SET status = 'sent'")).rejects.toThrow(/permission denied|row-level|0/);
    const c = await clinic();
    await expect(withTenant(appPool, c.t.id, (tx) => tx.query("UPDATE outbox_events SET status = 'sent'"))).rejects.toThrow(/permission denied/);
    await expect(workerPool.query('SELECT * FROM patients')).rejects.toThrow(/permission denied/);
    await expect(workerPool.query('SELECT * FROM users')).rejects.toThrow(/permission denied/);
  });

  it('histórico de mensagens do paciente: visível a recepção/dono, não ao profissional, e isolado por clínica', async () => {
    const c = await clinic();
    await c.consent();
    await c.book();
    await drain();
    const rec = await c.t.mk('receptionist', 'rita');
    const pro = await c.t.mk('professional', 'dra');
    const list = (await rec.c.get(`/api/patients/${c.pid}/messages`)).json().messages as { template: string; status: string }[];
    expect(list.map((m) => m.template)).toEqual(expect.arrayContaining(['appointment_confirmation', 'appointment_reminder']));
    expect(JSON.stringify(list)).not.toMatch(/5511988887777|paciente@exemplo/);
    expect((await pro.c.get(`/api/patients/${c.pid}/messages`)).statusCode).toBe(403);
    const other = await clinic();
    expect((await other.t.owner.get(`/api/patients/${c.pid}/messages`)).json().messages).toHaveLength(0);
  });

  it('consentimento é versionado: o histórico não é apagado e a leitura mostra o vigente', async () => {
    const c = await clinic();
    await c.consent('communication_email', true);
    await c.consent('communication_email', false);
    const cur = (await c.t.owner.get(`/api/patients/${c.pid}/consents`)).json().consents as { purpose: string; granted: boolean; recordedBy: string }[];
    expect(cur.find((x) => x.purpose === 'communication_email')).toMatchObject({ granted: false });
    const rows = await workerPool.query('SELECT 1').then(() => null); void rows;
    await expect(platformPool.query('SELECT * FROM patient_consents')).rejects.toThrow(/permission denied/);
  });
});

describe('webhooks de entrega', () => {
  const secret = 'whsec-teste-123';
  const sign = (ts: string, body: string, key = secret) => createHmac('sha256', key).update(`${ts}.`).update(body).digest('hex');
  const post = (url: string, body: string, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json', ...headers } });
  const generic = (events: object[], opts: { ts?: string; key?: string } = {}) => {
    const body = JSON.stringify({ events });
    const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
    return post('/api/webhooks/generic', body, { 'x-timestamp': ts, 'x-signature': sign(ts, body, opts.key) });
  };
  async function sentMessage() {
    const c = await clinic();
    await c.consent();
    await c.book();
    await drain();
    const e = (await c.events()).find((x) => x.payload.template === 'appointment_confirmation')!;
    return { c, e };
  }
  const delivery = async (id: string) => (await workerPool.query('SELECT delivery_status FROM outbox_events WHERE id = $1', [id])).rows[0].delivery_status;

  it('sem segredo configurado o webhook recusa tudo (503); com segredo errado, 401', async () => {
    expect((await generic([{ id: 'e1', messageId: 'm1', status: 'delivered' }])).statusCode).toBe(503);
    process.env.WEBHOOK_SECRET_GENERIC = secret;
    const r = await generic([{ id: 'e1', messageId: 'm1', status: 'delivered' }], { key: 'outro-segredo' });
    expect(r.statusCode).toBe(401);
    expect((await post('/api/webhooks/generic', '{"events":[]}', {})).statusCode).toBe(401);
    expect((await post('/api/webhooks/desconhecido', '{}', {})).statusCode).toBe(404);
  });

  it('proteção contra replay: assinatura válida porém fora da janela de 5 minutos é recusada', async () => {
    process.env.WEBHOOK_SECRET_GENERIC = secret;
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect((await generic([{ id: `old-${randomUUID()}`, messageId: 'm1', status: 'delivered' }], { ts: old })).statusCode).toBe(401);
  });

  it('entrega é aplicada; evento repetido é deduplicado; status não regride; "failed" não apaga "lido"', async () => {
    process.env.WEBHOOK_SECRET_GENERIC = secret;
    const { e } = await sentMessage();
    const evId = (s: string) => `${e.external_id}:${s}`;
    const d = await generic([{ id: evId('delivered'), messageId: e.external_id, status: 'delivered' }]);
    expect(d.json()).toMatchObject({ received: 1, stored: 1, duplicates: 0 });
    expect(await delivery(e.id)).toBe('delivered');
    const dup = await generic([{ id: evId('delivered'), messageId: e.external_id, status: 'delivered' }]);
    expect(dup.json()).toMatchObject({ stored: 0, duplicates: 1 });
    await generic([{ id: evId('read'), messageId: e.external_id, status: 'read' }]);
    expect(await delivery(e.id)).toBe('read');
    await generic([{ id: `late-${evId('delivered')}`, messageId: e.external_id, status: 'delivered' }]); // chegou atrasado
    expect(await delivery(e.id)).toBe('read');
    await generic([{ id: evId('failed'), messageId: e.external_id, status: 'failed' }]);
    expect(await delivery(e.id)).toBe('read');
  });

  it('evento fora de ordem (antes de o envio ser gravado) fica aberto e é aplicado quando a mensagem aparece', async () => {
    process.env.WEBHOOK_SECRET_GENERIC = secret;
    const { e } = await sentMessage();
    const futureId = `ext-${randomUUID()}`;
    const r = await generic([{ id: `${futureId}:read`, messageId: futureId, status: 'read' }]);
    expect(r.json().stored).toBe(1);
    expect((await workerPool.query(`SELECT status FROM webhook_receipts WHERE external_message_id = $1`, [futureId])).rows[0].status).toBe('received');
    await workerPool.query('UPDATE outbox_events SET external_id = $2 WHERE id = $1', [e.id, futureId]);
    await processReceipts(workerPool);
    expect((await workerPool.query(`SELECT status FROM webhook_receipts WHERE external_message_id = $1`, [futureId])).rows[0].status).toBe('processed');
    expect(await delivery(e.id)).toBe('read');
  });

  it('evento sem mensagem correspondente vai para dead-letter após 5 tentativas; Master recoloca na fila', async () => {
    process.env.WEBHOOK_SECRET_GENERIC = secret;
    const ghost = `ghost-${randomUUID()}`;
    await generic([{ id: `${ghost}:read`, messageId: ghost, status: 'read' }]);
    for (let i = 0; i < 5; i++) await processReceipts(workerPool);
    expect((await workerPool.query(`SELECT status FROM webhook_receipts WHERE external_message_id = $1`, [ghost])).rows[0].status).toBe('dead');
    const m = await master();
    const c = await clinic();
    const rq = await m.c.post('/api/master/integrations/requeue', { tenantId: c.t.id, code: m.code(), justification: 'reprocessar recibos' });
    expect(rq.statusCode).toBe(200);
    expect(rq.json().receipts).toBeGreaterThanOrEqual(1);
    expect((await workerPool.query(`SELECT status FROM webhook_receipts WHERE external_message_id = $1`, [ghost])).rows[0].status).toBe('received');
  });

  it('formato Meta (WhatsApp): assinatura X-Hub-Signature-256, só id/status são guardados; handshake GET', async () => {
    process.env.WHATSAPP_APP_SECRET = 'app-secret-teste';
    process.env.WHATSAPP_VERIFY_TOKEN = 'verify-token-teste';
    const { e } = await sentMessage();
    const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: e.external_id, status: 'delivered', recipient_id: '5511988887777', timestamp: '1' }] } }] }] });
    const good = createHmac('sha256', 'app-secret-teste').update(body).digest('hex');
    expect((await post('/api/webhooks/whatsapp', body, { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` })).statusCode).toBe(401);
    expect((await post('/api/webhooks/whatsapp', body, { 'x-hub-signature-256': `sha256=${good}` })).statusCode).toBe(200);
    expect(await delivery(e.id)).toBe('delivered');
    const stored = await workerPool.query('SELECT * FROM webhook_receipts WHERE external_message_id = $1', [e.external_id]);
    expect(JSON.stringify(stored.rows)).not.toContain('5511988887777'); // telefone do destinatário não é guardado
    const ok = await app.inject({ method: 'GET', url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token-teste&hub.challenge=abc123' });
    expect(ok.body).toBe('abc123');
    expect((await app.inject({ method: 'GET', url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=x' })).statusCode).toBe(403);
  });
});

describe('adaptadores reais contra servidor HTTP falso (não valida o provedor real)', () => {
  type Seen = { url: string; headers: IncomingHttpHeaders; body: string };
  async function fake(handler: (n: number, seen: Seen) => { status: number; json?: object; delayMs?: number }) {
    const seen: Seen[] = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const s = { url: req.url ?? '', headers: req.headers, body }; seen.push(s);
        const r = handler(seen.length, s);
        setTimeout(() => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.json ?? {})); }, r.delayMs ?? 0);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    return { base, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
  }
  const msg = { channel: 'email' as const, to: 'maria@exemplo.com', subject: 'Assunto', body: 'Texto com dado sensível 5511988887777', templateName: 'appointment_confirmation', idempotencyKey: 'idem-123', vars: ['A'] };

  it('classifica erros: 5xx/429/rede/timeout são transitórios; 4xx é definitivo; mensagem de erro não vaza conteúdo', async () => {
    const srv = await fake((n) => (n === 1 ? { status: 503 } : n === 2 ? { status: 429 } : n === 3 ? { status: 400, json: { error: 'telefone 5511988887777 inválido' } } : { status: 200, json: { id: 'msg-1' } }));
    process.env.EMAIL_API_URL = `${srv.base}/send`; process.env.EMAIL_API_KEY = 'k'; process.env.EMAIL_FROM = 'a@b.com';
    const ad = new EmailHttpAdapter();
    expect(ad.configured()).toBe(true);
    await expect(ad.send(msg)).rejects.toMatchObject({ retryable: true, code: 'http_503' });
    await expect(ad.send(msg)).rejects.toMatchObject({ retryable: true, code: 'http_429' });
    const perm = await ad.send(msg).catch((e: AdapterError) => e);
    expect(perm).toMatchObject({ retryable: false, code: 'http_400' });
    expect((perm as Error).message).not.toMatch(/5511988887777|maria@/);
    expect(await ad.send(msg)).toEqual({ externalId: 'msg-1' });
    expect(srv.seen[3]!.headers['idempotency-key']).toBe('idem-123');
    expect(srv.seen[3]!.headers.authorization).toBe('Bearer k');
    await srv.close();
    await expect(httpJson({ url: 'http://127.0.0.1:1/x', timeoutMs: 300 })).rejects.toMatchObject({ retryable: true, code: 'network' });
    delete process.env.EMAIL_API_URL; delete process.env.EMAIL_API_KEY; delete process.env.EMAIL_FROM;
  });

  it('timeout é transitório', async () => {
    const srv = await fake(() => ({ status: 200, delayMs: 400 }));
    await expect(httpJson({ url: `${srv.base}/slow`, timeoutMs: 100 })).rejects.toMatchObject({ retryable: true, code: 'timeout' });
    await srv.close();
  });

  it('WhatsApp Cloud: monta o template com parâmetros, usa Bearer e devolve o id; sem credenciais é "not_configured" transitório', async () => {
    const wa = new WhatsAppCloudAdapter();
    expect(wa.configured()).toBe(false);
    await expect(wa.send({ ...msg, channel: 'whatsapp', to: '+5511988887777' })).rejects.toMatchObject({ retryable: true, code: 'not_configured' });
    const srv = await fake(() => ({ status: 200, json: { messages: [{ id: 'wamid.ABC' }] } }));
    process.env.WHATSAPP_TOKEN = 'tok'; process.env.WHATSAPP_PHONE_NUMBER_ID = '555'; process.env.WHATSAPP_API_BASE = srv.base;
    const r = await wa.send({ ...msg, channel: 'whatsapp', to: '+55 (11) 98888-7777', vars: ['Maria', 'Dr. Paulo'] });
    expect(r).toEqual({ externalId: 'wamid.ABC' });
    const s = srv.seen[0]!;
    expect(s.url).toBe('/555/messages');
    expect(s.headers.authorization).toBe('Bearer tok');
    const sent = JSON.parse(s.body);
    expect(sent).toMatchObject({ messaging_product: 'whatsapp', to: '5511988887777', type: 'template', template: { name: 'appointment_confirmation', language: { code: 'pt_BR' } } });
    expect(sent.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(['Maria', 'Dr. Paulo']);
    await srv.close();
    delete process.env.WHATSAPP_TOKEN; delete process.env.WHATSAPP_PHONE_NUMBER_ID; delete process.env.WHATSAPP_API_BASE;
  });
});

describe('armazenamento de arquivos (porta + disco local)', () => {
  it('grava e lê com hash e tamanho; isola por tenant; recusa path traversal e sobrescrita', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clinica-storage-'));
    try {
      const st = new LocalFsStorage(dir);
      const a = randomUUID(), b = randomUUID();
      const data = Buffer.from('conteúdo do exame');
      const obj = await st.put(a, 'patients/p1/exame.pdf', data);
      expect(obj).toMatchObject({ key: 'patients/p1/exame.pdf', size: data.length });
      expect(obj.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await st.get(a, 'patients/p1/exame.pdf')).equals(data)).toBe(true);
      await expect(st.get(b, 'patients/p1/exame.pdf')).rejects.toThrow(); // outro tenant não enxerga
      for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'a\\b', 'a//b', '..', '.', 'a/./b', '']) {
        await expect(st.put(a, bad, data), bad).rejects.toThrow(/inválida/);
        await expect(st.get(a, bad), bad).rejects.toThrow(/inválida/);
      }
      await expect(st.get(`../${b}`, 'x')).rejects.toThrow(/inválido/); // tenant só aceita UUID
      await expect(st.put(a, 'patients/p1/exame.pdf', data)).rejects.toThrow(); // nunca sobrescreve
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

void PW; void Client;
