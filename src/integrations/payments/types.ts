import { AdapterError } from '../types.js';

/** Status normalizado, comum a qualquer gateway. */
export type ProviderStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'refunded';

export interface ProviderPayment {
  id: string;
  status: ProviderStatus;
  /** Status bruto do provedor (diagnóstico; nunca vai para o paciente). */
  rawStatus: string;
  amountCents: number;
  /** Referência que enviamos ao criar (id da cobrança). É assim que casamos o pagamento com a cobrança. */
  externalReference: string | null;
  /** Como o dinheiro entrou: Pix ou cartão (crédito/débito/saldo). */
  paidMethod: 'pix' | 'card';
  refundedCents: number;
}

export interface CreateInput {
  amountCents: number;
  description: string;
  externalReference: string;
  idempotencyKey: string;
  payerEmail?: string | null;
  notificationUrl?: string | null;
  expiresAt: Date;
}
export interface PixCreated { providerPaymentId: string; status: ProviderStatus; qrCode: string; qrCodeBase64: string | null }
export interface LinkCreated { checkoutUrl: string }

/** Porta do gateway de pagamento. Qualquer provedor (Mercado Pago, outro) implementa isto. */
export interface PaymentGateway {
  readonly provider: 'mercadopago' | 'sandbox';
  createPix(i: CreateInput): Promise<PixCreated>;
  createCheckoutLink(i: CreateInput): Promise<LinkCreated>;
  getPayment(providerPaymentId: string): Promise<ProviderPayment | null>;
  /** Procura o pagamento mais relevante de uma referência (usado no link, que só tem id de pagamento depois de pago). */
  findByReference(externalReference: string): Promise<ProviderPayment | null>;
  cancel(providerPaymentId: string): Promise<void>;
  refund(providerPaymentId: string, idempotencyKey: string): Promise<void>;
}

/** Traduz erro do adaptador em mensagem que a recepção entende. Nunca inclui corpo de requisição/resposta. */
export function friendlyGatewayError(e: unknown): { status: number; message: string; code: string } {
  if (e instanceof AdapterError) {
    if (e.code === 'http_401' || e.code === 'http_403') return { status: 502, code: 'gateway_credentials', message: 'O Mercado Pago recusou as credenciais. Revise o Access Token em Gestão → Pagamentos.' };
    if (e.code === 'http_400' || e.code === 'http_422') return { status: 502, code: 'gateway_rejected', message: 'O Mercado Pago recusou os dados da cobrança. Confira o e-mail do pagador e o valor.' };
    if (e.retryable) return { status: 502, code: 'gateway_unavailable', message: 'O Mercado Pago está indisponível agora. Tente novamente em instantes.' };
    return { status: 502, code: 'gateway_error', message: 'O Mercado Pago não conseguiu concluir a operação.' };
  }
  return { status: 500, code: 'internal', message: 'Erro interno ao falar com o gateway de pagamento.' };
}
