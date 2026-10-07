import { createHash } from 'node:crypto';
import { MercadoPagoGateway } from '../../integrations/payments/mercadopago.js';
import { SandboxPaymentGateway } from '../../integrations/payments/sandbox.js';
import type { PaymentGateway, ProviderPayment } from '../../integrations/payments/types.js';
import { integrationEnv } from '../../server/config.js';
import { decryptSecret } from '../../server/crypto.js';
import type { Tx } from '../../server/http.js';
import { family } from '../patients/family.js';
import { nextReceiptNumber } from '../finance/receipt.js';

export type Mode = 'disabled' | 'sandbox' | 'live';
export interface Settings { mode: Mode; accessToken: string | null; tokenLast4: string | null; webhookSecret: string | null; stored: boolean }

/** Configuração da clínica. Sem linha gravada vale o padrão do ambiente (desenvolvimento: sandbox; produção: desligado). */
export async function loadSettings(tx: Tx): Promise<Settings> {
  const r = await tx.query<{ mode: Mode; access_token_enc: string | null; token_last4: string | null; webhook_secret_enc: string | null }>(
    'SELECT mode, access_token_enc, token_last4, webhook_secret_enc FROM payment_settings');
  const row = r.rows[0];
  if (!row) return { mode: integrationEnv().defaultMode, accessToken: null, tokenLast4: null, webhookSecret: null, stored: false };
  return {
    mode: row.mode, tokenLast4: row.token_last4, stored: true,
    accessToken: row.access_token_enc ? decryptSecret(row.access_token_enc) : null,
    webhookSecret: row.webhook_secret_enc ? decryptSecret(row.webhook_secret_enc) : null,
  };
}

const sandboxGateway = new SandboxPaymentGateway();
export function gatewayFor(s: Settings): PaymentGateway | null {
  if (s.mode === 'sandbox') return sandboxGateway;
  if (s.mode === 'live' && s.accessToken) return new MercadoPagoGateway(s.accessToken, integrationEnv().mercadopago.apiBase);
  return null;
}

/** Id da cobrança derivado da chave de idempotência: repetir a chamada (duplo clique, timeout) cai na mesma cobrança e na mesma referência do provedor. */
export function intentIdFor(tenantId: string, key: string): string {
  const h = createHash('sha256').update(`${tenantId}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const notificationUrl = (tenantId: string) => {
  const base = integrationEnv().publicBaseUrl;
  return base ? `${base}/api/webhooks/mercadopago/${tenantId}` : null;
};

async function auditSystem(tx: Tx, tenantId: string, actorId: string | null, action: string, entityId: string, metadata: object) {
  await tx.query(
    'INSERT INTO audit_events (tenant_id, actor_id, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)',
    [tenantId, actorId, action, 'payment_intent', entityId, JSON.stringify(metadata)]);
}

async function insertMovement(tx: Tx, a: { tenantId: string; patientId: string; kind: 'payment' | 'refund'; method: 'pix' | 'card'; cents: string; note: string; key: string; createdBy: string }): Promise<string> {
  const receipt = a.kind === 'payment' ? await nextReceiptNumber(tx, a.tenantId) : null;
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO financial_movements (tenant_id, patient_id, kind, method, amount_cents, note, idempotency_key, created_by, receipt_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
    [a.tenantId, a.patientId, a.kind, a.method, a.cents, a.note, a.key, a.createdBy, receipt]);
  if (ins.rows[0]) return ins.rows[0].id;
  return (await tx.query<{ id: string }>('SELECT id FROM financial_movements WHERE idempotency_key = $1', [a.key])).rows[0]!.id;
}

export interface IntentRow {
  id: string; patient_id: string; amount_cents: string; status: string; method: string; created_by: string; provider_payment_id: string | null;
  payment_movement_id: string | null; refund_movement_id: string | null; description: string;
}

/**
 * Aplica o estado do pagamento no provedor à cobrança, de forma idempotente. Regras:
 * - só aceita o pagamento se a referência for exatamente o id desta cobrança e o valor for igual (senão, auditoria e nada muda);
 * - aprovado vira UM movimento de pagamento (com recibo numerado); estornado vira UM movimento de estorno;
 * - o saldo do paciente só muda por movimentos imutáveis, como em qualquer outro pagamento.
 */
export async function applyProviderPayment(tx: Tx, tenantId: string, intentId: string, p: ProviderPayment, actorId: string | null): Promise<{ status: string; changed: boolean }> {
  const cur = await tx.query<IntentRow>('SELECT id, patient_id, amount_cents::text, status, method, created_by, provider_payment_id, payment_movement_id, refund_movement_id, description FROM payment_intents WHERE id = $1 FOR UPDATE', [intentId]);
  const it = cur.rows[0];
  if (!it) return { status: 'unknown', changed: false };
  if (p.externalReference !== it.id) {
    await auditSystem(tx, tenantId, actorId, 'payment.reference_mismatch', it.id, { providerPaymentId: p.id });
    return { status: it.status, changed: false };
  }
  if (BigInt(p.amountCents) !== BigInt(it.amount_cents)) {
    await auditSystem(tx, tenantId, actorId, 'payment.amount_mismatch', it.id, { expectedCents: it.amount_cents, providerCents: p.amountCents, providerPaymentId: p.id });
    return { status: it.status, changed: false };
  }
  let status = it.status;
  let changed = false;
  const baseUpdate = async (extra: Record<string, unknown> = {}) => {
    const sets = ['provider_status = $2', 'provider_payment_id = COALESCE(provider_payment_id, $3)', ...Object.keys(extra).map((k, i) => `${k} = $${i + 4}`)];
    await tx.query(`UPDATE payment_intents SET ${sets.join(', ')} WHERE id = $1`, [it.id, p.rawStatus, p.id, ...Object.values(extra)]);
  };

  if ((p.status === 'approved' || p.status === 'refunded') && status === 'pending') {
    const mid = await insertMovement(tx, { tenantId, patientId: it.patient_id, kind: 'payment', method: p.paidMethod, cents: it.amount_cents, note: `Pagamento online (${p.paidMethod === 'pix' ? 'Pix' : 'cartão'}) · cobrança ${it.id.slice(0, 8)}`, key: `gw:${it.id}:pay`, createdBy: it.created_by });
    await baseUpdate({ status: 'approved', paid_method: p.paidMethod, payment_movement_id: mid });
    it.payment_movement_id = mid; status = 'approved'; changed = true;
    await auditSystem(tx, tenantId, actorId, 'payment.approved', it.id, { providerPaymentId: p.id, method: p.paidMethod, amountCents: it.amount_cents });
  }
  if (p.status === 'refunded' && status === 'approved') {
    const fam = await family(tx, it.patient_id);
    const net = await tx.query<{ net: string }>(
      `SELECT (COALESCE(SUM(amount_cents) FILTER (WHERE kind='payment'),0) - COALESCE(SUM(amount_cents) FILTER (WHERE kind='refund'),0))::text AS net FROM financial_movements WHERE patient_id = ANY($1::uuid[])`, [fam]);
    if (BigInt(net.rows[0]!.net) < BigInt(it.amount_cents)) {
      await auditSystem(tx, tenantId, actorId, 'payment.refund_unreconciled', it.id, { reason: 'saldo pago insuficiente para refletir o estorno; revisar manualmente' });
    } else {
      const method = (await tx.query<{ paid_method: 'pix' | 'card' }>('SELECT paid_method FROM payment_intents WHERE id = $1', [it.id])).rows[0]!.paid_method;
      const rid = await insertMovement(tx, { tenantId, patientId: it.patient_id, kind: 'refund', method, cents: it.amount_cents, note: `Estorno de pagamento online · cobrança ${it.id.slice(0, 8)}`, key: `gw:${it.id}:refund`, createdBy: it.created_by });
      await baseUpdate({ status: 'refunded', refund_movement_id: rid });
      status = 'refunded'; changed = true;
      await auditSystem(tx, tenantId, actorId, 'payment.refunded', it.id, { providerPaymentId: p.id });
    }
  }
  if (['rejected', 'cancelled', 'expired'].includes(p.status) && status === 'pending') {
    await baseUpdate({ status: p.status });
    status = p.status; changed = true;
    await auditSystem(tx, tenantId, actorId, `payment.${p.status}`, it.id, { providerPaymentId: p.id });
  }
  // cobrança finalizada é imutável no banco: repetir a notificação não tenta atualizar nada
  if (!changed && !['rejected', 'cancelled', 'expired', 'refunded'].includes(status)) await baseUpdate();
  return { status, changed };
}
