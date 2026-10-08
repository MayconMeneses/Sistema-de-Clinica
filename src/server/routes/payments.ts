import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute, type ClinicCtx } from '../context.js';
import { sandboxApprove } from '../../integrations/payments/sandbox.js';
import { friendlyGatewayError, type ProviderPayment } from '../../integrations/payments/types.js';
import { applyProviderPayment, gatewayFor, intentIdFor, loadSettings, notificationUrl } from '../../modules/payments/service.js';
import { assertActive, family } from '../../modules/patients/family.js';
import { encryptSecret } from '../crypto.js';
import { config } from '../config.js';
import { badRequest, conflict, HttpError, mapDbError, notFound } from '../http.js';

const CAP = { cap: 'payments.gateway' } as const;
const idParam = z.object({ id: z.string().uuid() });
const EXPIRES = { pix: 30 * 60_000, link: 24 * 3600_000 };

const INTENT_SELECT = `SELECT i.id, i.patient_id AS "patientId", p.name AS "patientName", i.amount_cents::text AS "amountCents", i.description, i.method, i.status,
    i.provider, i.checkout_url AS "checkoutUrl", i.pix_qr_code AS "pixQrCode", i.pix_qr_base64 AS "pixQrBase64", i.expires_at AS "expiresAt",
    (i.status = 'pending' AND i.expires_at < now()) AS expired, i.created_at AS "createdAt", i.paid_method AS "paidMethod", m.receipt_number::int AS "receiptNumber",
    i.payment_movement_id AS "paymentMovementId", i.refunded_cents::text AS "refundedCents"
  FROM payment_intents i JOIN patients p ON p.tenant_id = i.tenant_id AND p.id = i.patient_id
  LEFT JOIN financial_movements m ON m.tenant_id = i.tenant_id AND m.id = i.payment_movement_id`;

async function requireGateway(ctx: ClinicCtx) {
  const s = await loadSettings(ctx.tx);
  const gw = gatewayFor(s);
  if (!gw) throw new HttpError(409, s.mode === 'live' ? 'Credencial do Mercado Pago ausente. Revise em Gestão → Pagamentos.' : 'Pagamentos online não estão ativos para esta clínica. Ative em Gestão → Pagamentos.', 'payments_disabled');
  return { s, gw };
}
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof HttpError) throw e;
    const f = friendlyGatewayError(e);
    if (f.status === 500) throw e;
    throw new HttpError(f.status, f.message, f.code);
  }
}
async function loadIntent(ctx: ClinicCtx, id: string, lock = false) {
  const r = await ctx.tx.query<{ id: string; status: string; method: 'pix' | 'link'; provider: string; provider_payment_id: string | null; patient_id: string; amount_cents: string; created_by: string; refunded_cents: string }>(
    `SELECT id, status, method, provider, provider_payment_id, patient_id, amount_cents::text, created_by, refunded_cents::text FROM payment_intents WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!r.rows[0]) throw notFound('Cobrança não encontrada.');
  return r.rows[0];
}
const view = async (ctx: ClinicCtx, id: string) => (await ctx.tx.query(`${INTENT_SELECT} WHERE i.id = $1`, [id])).rows[0];

/** Consulta o provedor e aplica o estado à cobrança (usado pelo botão "Verificar" e pelo webhook). */
async function syncIntent(ctx: ClinicCtx, id: string) {
  const it = await loadIntent(ctx, id, true);
  if (['rejected', 'cancelled', 'expired', 'refunded'].includes(it.status)) return it.status;
  const { gw } = await requireGateway(ctx);
  if (gw.provider !== it.provider) throw conflict('O modo de pagamento da clínica mudou desde que esta cobrança foi criada.');
  const p: ProviderPayment | null = await run(() => (it.provider_payment_id ? gw.getPayment(it.provider_payment_id) : gw.findByReference(it.id)));
  if (!p) return it.status;
  const r = await applyProviderPayment(ctx.tx, ctx.tenantId, it.id, p, ctx.user.id);
  return r.status;
}

export function paymentRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ Configuração (credenciais nunca saem do servidor)
  clinicRoute(app, 'GET', '/api/payments/settings', { ...CAP, perm: 'payments.manage' }, async (ctx) => {
    const s = await loadSettings(ctx.tx);
    return {
      provider: 'mercadopago', mode: s.mode, defaultMode: s.mode, tokenConfigured: !!s.accessToken, tokenLast4: s.tokenLast4, webhookSecretConfigured: !!s.webhookSecret,
      notificationUrl: notificationUrl(ctx.tenantId), publicBaseUrlConfigured: !!notificationUrl(ctx.tenantId), production: config.isProd,
    };
  });

  clinicRoute(app, 'PUT', '/api/payments/settings', { ...CAP, perm: 'payments.manage' }, async (ctx) => {
    const b = z.object({
      mode: z.enum(['disabled', 'sandbox', 'live']).optional(),
      accessToken: z.string().trim().min(10).max(300).optional(),
      webhookSecret: z.string().trim().min(8).max(200).optional(),
      clearCredentials: z.boolean().optional(),
    }).parse(ctx.req.body);
    const oldRow = (await ctx.tx.query<{ mode: string; access_token_enc: string | null; token_last4: string | null; webhook_secret_enc: string | null }>(
      'SELECT mode, access_token_enc, token_last4, webhook_secret_enc FROM payment_settings')).rows[0];
    const mode = b.mode ?? (await loadSettings(ctx.tx)).mode;
    const tokenEnc = b.clearCredentials ? null : b.accessToken ? encryptSecret(b.accessToken) : oldRow?.access_token_enc ?? null;
    const last4 = b.clearCredentials ? null : b.accessToken ? b.accessToken.slice(-4) : oldRow?.token_last4 ?? null;
    const secretEnc = b.clearCredentials ? null : b.webhookSecret ? encryptSecret(b.webhookSecret) : oldRow?.webhook_secret_enc ?? null;
    if (mode === 'live' && !tokenEnc) throw badRequest('Para usar o Mercado Pago de verdade, informe o Access Token.');
    if (mode === 'sandbox' && config.isProd) throw badRequest('O modo de teste interno não existe em produção.');
    await ctx.tx.query(
      `INSERT INTO payment_settings (tenant_id, mode, access_token_enc, token_last4, webhook_secret_enc, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id) DO UPDATE SET mode = EXCLUDED.mode, access_token_enc = EXCLUDED.access_token_enc, token_last4 = EXCLUDED.token_last4,
         webhook_secret_enc = EXCLUDED.webhook_secret_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ctx.tenantId, mode, tokenEnc, last4, secretEnc, ctx.user.id]);
    await audit(ctx, 'payments.settings', 'payment_settings', ctx.tenantId, { mode, tokenChanged: !!b.accessToken, secretChanged: !!b.webhookSecret, cleared: !!b.clearCredentials });
    return { ok: true };
  });

  // ------------------------------------------------------------------ Cobranças
  clinicRoute(app, 'POST', '/api/payments/intents', { ...CAP, perm: 'payments.charge' }, async (ctx) => {
    const b = z.object({
      patientId: z.string().uuid(), amountCents: z.number().int().min(100).max(100_000_000), method: z.enum(['pix', 'link']),
      description: z.string().trim().min(2).max(120).default('Atendimento odontológico'),
      payerEmail: z.string().trim().toLowerCase().email().max(200).optional(), idempotencyKey: z.string().trim().min(8).max(100),
    }).parse(ctx.req.body);
    const id = intentIdFor(ctx.tenantId, b.idempotencyKey);
    const dup = await ctx.tx.query('SELECT 1 FROM payment_intents WHERE id = $1', [id]);
    if (dup.rowCount) return { ...(await view(ctx, id)), duplicate: true };
    const { gw } = await requireGateway(ctx);
    await assertActive(ctx.tx, b.patientId);
    const email = b.payerEmail ?? (await ctx.tx.query<{ email: string | null }>('SELECT email FROM patients WHERE id = $1', [b.patientId])).rows[0]?.email ?? undefined;
    if (b.method === 'pix' && !email) throw badRequest('Informe o e-mail do pagador: o Pix do Mercado Pago exige.');
    const expiresAt = new Date(Date.now() + EXPIRES[b.method]);
    const input = { amountCents: b.amountCents, description: b.description, externalReference: id, idempotencyKey: id, payerEmail: email, notificationUrl: notificationUrl(ctx.tenantId), expiresAt };
    // O provedor é chamado antes de gravar: se falhar, nada fica gravado (a mesma chave repete com segurança, pois o id é derivado dela).
    const created = await run(async () => (b.method === 'pix' ? { pix: await gw.createPix(input) } : { link: await gw.createCheckoutLink(input) }));
    try {
      await ctx.tx.query(
        `INSERT INTO payment_intents (id, tenant_id, patient_id, amount_cents, description, method, provider, provider_payment_id, checkout_url, pix_qr_code, pix_qr_base64, payer_email, expires_at, idempotency_key, created_by, provider_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending')`,
        [id, ctx.tenantId, b.patientId, b.amountCents, b.description, b.method, gw.provider, created.pix?.providerPaymentId ?? null, created.link?.checkoutUrl ?? null,
         created.pix?.qrCode ?? null, created.pix?.qrCodeBase64 ?? null, email ?? null, expiresAt, b.idempotencyKey, ctx.user.id]);
    } catch (e) { return mapDbError(e); }
    await audit(ctx, 'payment.create', 'payment_intent', id, { method: b.method, amountCents: b.amountCents, provider: gw.provider });
    return { ...(await view(ctx, id)), duplicate: false };
  });

  clinicRoute(app, 'GET', '/api/payments/intents', { ...CAP, perm: 'finance.read' }, async (ctx) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired', 'refunded']).optional(), patientId: z.string().uuid().optional() }).parse(ctx.req.query);
    const fam = q.patientId ? await family(ctx.tx, q.patientId) : null;
    const r = await ctx.tx.query(
      `${INTENT_SELECT} WHERE ($1::text IS NULL OR i.status = $1) AND ($2::uuid[] IS NULL OR i.patient_id = ANY($2)) ORDER BY i.created_at DESC LIMIT 100`, [q.status ?? null, fam]);
    return { intents: r.rows };
  });

  clinicRoute(app, 'POST', '/api/payments/intents/:id/sync', { ...CAP, perm: 'payments.charge' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    await syncIntent(ctx, id);
    return view(ctx, id);
  });

  clinicRoute(app, 'POST', '/api/payments/intents/:id/cancel', { ...CAP, perm: 'payments.charge' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const it = await loadIntent(ctx, id, true);
    if (it.status !== 'pending') throw conflict('Só uma cobrança pendente pode ser cancelada.');
    const { gw } = await requireGateway(ctx);
    // Confere antes: se o paciente já pagou (ou o provedor já encerrou), reconcilia em vez de cancelar por cima.
    const p = it.provider_payment_id ? await run(() => gw.getPayment(it.provider_payment_id!)) : null;
    if (p && p.status !== 'pending') {
      await applyProviderPayment(ctx.tx, ctx.tenantId, id, p, ctx.user.id);
      // Responde 200 (e não erro) para o que foi conciliado ficar gravado: um erro desfaria a transação.
      if (p.status === 'approved' || p.status === 'refunded') return { ...(await view(ctx, id)), notice: 'O pagamento já foi confirmado no Mercado Pago: a cobrança não foi cancelada e o pagamento foi registrado. Se precisar devolver, use Estornar.' };
      return view(ctx, id);
    }
    if (it.provider_payment_id) await run(() => gw.cancel(it.provider_payment_id!));
    await ctx.tx.query("UPDATE payment_intents SET status = 'cancelled', provider_status = 'cancelled' WHERE id = $1", [id]);
    await audit(ctx, 'payment.cancel', 'payment_intent', id);
    return view(ctx, id);
  });

  // Estorno total (sem valor) ou parcial (amountCents). Pode ser repetido até devolver tudo; cada devolução é um movimento imutável.
  clinicRoute(app, 'POST', '/api/payments/intents/:id/refund', { ...CAP, perm: 'finance.approve' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ reason: z.string().trim().min(3).max(200), amountCents: z.number().int().min(1).max(100_000_000).optional() }).parse(ctx.req.body);
    const it = await loadIntent(ctx, id, true);
    if (it.status !== 'approved' || !it.provider_payment_id) throw conflict(it.status === 'refunded' ? 'Esta cobrança já foi estornada por inteiro.' : 'Só uma cobrança paga pode ser estornada.');
    const before = BigInt(it.refunded_cents);
    const remaining = BigInt(it.amount_cents) - before;
    const amount = b.amountCents !== undefined ? BigInt(b.amountCents) : remaining;
    if (amount > remaining) throw badRequest(`O valor do estorno passa do que resta devolver (${(Number(remaining) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}).`);
    const { gw } = await requireGateway(ctx);
    // A chave de idempotência depende do estado: repetir o mesmo pedido não devolve duas vezes; um novo estorno parcial tem outra chave.
    const full = before === 0n && amount === remaining;
    await run(() => gw.refund(it.provider_payment_id!, full ? `refund-${id}` : `refund-${id}-${before}-${amount}`, full ? undefined : Number(amount)));
    const p = await run(() => gw.getPayment(it.provider_payment_id!));
    if (!p || BigInt(p.status === 'refunded' ? it.amount_cents : p.refundedCents) < before + amount) throw new HttpError(502, 'O Mercado Pago ainda não confirmou o estorno. Use Verificar em instantes.', 'gateway_pending');
    const r = await applyProviderPayment(ctx.tx, ctx.tenantId, id, p, ctx.user.id);
    await audit(ctx, 'payment.refund', 'payment_intent', id, { reason: b.reason, amountCents: amount.toString() });
    const v = await view(ctx, id);
    if (BigInt((v as { refundedCents: string }).refundedCents) < before + amount) return { ...v, notice: 'O estorno foi feito no Mercado Pago, mas o saldo pago do paciente não comporta o lançamento. Revise o financeiro do paciente.' };
    return r.status === 'refunded' ? v : { ...v, notice: 'Estorno parcial registrado.' };
  });

  // Somente desenvolvimento: simula o paciente pagando no sandbox (sem dinheiro, sem rede).
  clinicRoute(app, 'POST', '/api/payments/intents/:id/sandbox-approve', { ...CAP, perm: 'payments.charge' }, async (ctx) => {
    if (config.isProd) throw notFound();
    const { id } = idParam.parse(ctx.req.params);
    const it = await loadIntent(ctx, id);
    if (it.status !== 'pending') throw conflict('Só uma cobrança pendente pode ser paga no modo de teste.');
    if (it.provider !== 'sandbox') throw conflict('Só cobranças do modo de teste podem ser simuladas.');
    if (!sandboxApprove(it.id, it.method === 'pix' ? 'pix' : 'card')) throw conflict('Esta cobrança de teste não existe mais na memória do servidor (ele foi reiniciado). Crie outra.');
    await syncIntent(ctx, id);
    return view(ctx, id);
  });
}
