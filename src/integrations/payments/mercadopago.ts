import { httpJson } from '../http.js';
import { AdapterError } from '../types.js';
import type { CreateInput, LinkCreated, PaymentGateway, PixCreated, ProviderPayment, ProviderStatus } from './types.js';

/**
 * Mercado Pago — adaptador REAL (API REST). Estado: ESCRITO e testado apenas contra um servidor HTTP falso local
 * (formato das requisições, idempotência, classificação de erros). NÃO foi validado contra o Mercado Pago de verdade:
 * isso exige credenciais da clínica (use primeiro as credenciais de TESTE do próprio Mercado Pago) — ver docs/PAGAMENTOS.md.
 *
 * Endpoints usados: POST /v1/payments (Pix), POST /checkout/preferences (link), GET /v1/payments/{id},
 * GET /v1/payments/search?external_reference=…, PUT /v1/payments/{id} (cancelar), POST /v1/payments/{id}/refunds (estorno total).
 */
export class MercadoPagoGateway implements PaymentGateway {
  readonly provider = 'mercadopago' as const;
  constructor(private accessToken: string, private apiBase = 'https://api.mercadopago.com') {}

  private auth() { return { authorization: `Bearer ${this.accessToken}` }; }
  private reais = (cents: number) => Math.round(cents) / 100;

  async createPix(i: CreateInput): Promise<PixCreated> {
    if (!i.payerEmail) throw new AdapterError('E-mail do pagador é obrigatório no Pix', false, 'http_400');
    const { json } = await httpJson({
      url: `${this.apiBase}/v1/payments`, headers: this.auth(), idempotencyKey: i.idempotencyKey, idempotencyHeader: 'x-idempotency-key',
      body: {
        transaction_amount: this.reais(i.amountCents), description: i.description, payment_method_id: 'pix',
        payer: { email: i.payerEmail }, external_reference: i.externalReference,
        ...(i.notificationUrl ? { notification_url: i.notificationUrl } : {}),
        date_of_expiration: toOffsetIso(i.expiresAt),
      },
    });
    const id = json.id;
    const tx = (json.point_of_interaction as { transaction_data?: { qr_code?: string; qr_code_base64?: string } } | undefined)?.transaction_data;
    if ((typeof id !== 'number' && typeof id !== 'string') || !tx?.qr_code) throw new AdapterError('Resposta do provedor sem dados do Pix', false, 'bad_response');
    return { providerPaymentId: String(id), status: mapStatus(String(json.status ?? 'pending'), json.status_detail as string | undefined), qrCode: tx.qr_code, qrCodeBase64: tx.qr_code_base64 ?? null };
  }

  async createCheckoutLink(i: CreateInput): Promise<LinkCreated> {
    const { json } = await httpJson({
      url: `${this.apiBase}/checkout/preferences`, headers: this.auth(), idempotencyKey: i.idempotencyKey, idempotencyHeader: 'x-idempotency-key',
      body: {
        items: [{ title: i.description, quantity: 1, unit_price: this.reais(i.amountCents), currency_id: 'BRL' }],
        external_reference: i.externalReference, ...(i.notificationUrl ? { notification_url: i.notificationUrl } : {}),
        ...(i.payerEmail ? { payer: { email: i.payerEmail } } : {}),
        expires: true, expiration_date_to: toOffsetIso(i.expiresAt),
      },
    });
    const url = (json.init_point ?? json.sandbox_init_point) as string | undefined;
    if (!url || !/^https:\/\//.test(url)) throw new AdapterError('Resposta do provedor sem link de pagamento', false, 'bad_response');
    return { checkoutUrl: url };
  }

  async getPayment(id: string): Promise<ProviderPayment | null> {
    try {
      const { json } = await httpJson({ url: `${this.apiBase}/v1/payments/${encodeURIComponent(id)}`, method: 'GET', headers: this.auth() });
      return this.parse(json);
    } catch (e) {
      if (e instanceof AdapterError && e.code === 'http_404') return null;
      throw e;
    }
  }

  async findByReference(ref: string): Promise<ProviderPayment | null> {
    const { json } = await httpJson({
      url: `${this.apiBase}/v1/payments/search?external_reference=${encodeURIComponent(ref)}&sort=date_created&criteria=desc`, method: 'GET', headers: this.auth(),
    });
    const results = (json.results as Record<string, unknown>[] | undefined) ?? [];
    const parsed = results.map((r) => this.parse(r)).filter((p) => p.externalReference === ref);
    return parsed.find((p) => p.status === 'approved') ?? parsed[0] ?? null;
  }

  async cancel(id: string): Promise<void> {
    await httpJson({ url: `${this.apiBase}/v1/payments/${encodeURIComponent(id)}`, method: 'PUT', headers: this.auth(), body: { status: 'cancelled' } });
  }

  async refund(id: string, idempotencyKey: string): Promise<void> {
    await httpJson({
      url: `${this.apiBase}/v1/payments/${encodeURIComponent(id)}/refunds`, headers: this.auth(), idempotencyKey, idempotencyHeader: 'x-idempotency-key', body: {},
    });
  }

  private parse(j: Record<string, unknown>): ProviderPayment {
    const amount = Number(j.transaction_amount);
    if (!Number.isFinite(amount) || j.id === undefined) throw new AdapterError('Resposta do provedor inválida', false, 'bad_response');
    const raw = String(j.status ?? 'pending');
    const ptype = String(j.payment_type_id ?? ''), pmethod = String(j.payment_method_id ?? '');
    return {
      id: String(j.id), rawStatus: raw, status: mapStatus(raw, j.status_detail as string | undefined),
      amountCents: Math.round(amount * 100), externalReference: typeof j.external_reference === 'string' && j.external_reference ? j.external_reference : null,
      paidMethod: pmethod === 'pix' || ptype === 'bank_transfer' ? 'pix' : 'card',
      refundedCents: Math.round(Number(j.transaction_amount_refunded ?? 0) * 100),
    };
  }
}

/** Mercado Pago → status normalizado. `cancelled` com detalhe `expired` vira `expired`; estorno e chargeback viram `refunded`. */
export function mapStatus(raw: string, detail?: string): ProviderStatus {
  switch (raw) {
    case 'approved': return 'approved';
    case 'rejected': return 'rejected';
    case 'cancelled': return detail === 'expired' ? 'expired' : 'cancelled';
    case 'refunded': case 'charged_back': return 'refunded';
    default: return 'pending'; // pending, in_process, in_mediation, authorized
  }
}

/** ISO com fuso (-03:00), formato que o Mercado Pago exige em date_of_expiration. */
function toOffsetIso(d: Date): string {
  const sp = new Date(d.getTime() - 3 * 3600_000).toISOString().replace('Z', '-03:00');
  return sp;
}
