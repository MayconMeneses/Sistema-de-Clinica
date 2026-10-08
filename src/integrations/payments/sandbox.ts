import { randomUUID } from 'node:crypto';
import { AdapterError } from '../types.js';
import type { CreateInput, LinkCreated, PaymentGateway, PixCreated, ProviderPayment, ProviderStatus } from './types.js';

interface SandboxPayment { id: string; reference: string; amountCents: number; status: ProviderStatus; paidMethod: 'pix' | 'card'; refunded: boolean; refundedCents: number; method: 'pix' | 'link' }
/** Estado do sandbox, só em memória do processo. Nada sai da máquina e nenhum dinheiro existe. */
const payments = new Map<string, SandboxPayment>();

/** Simula a confirmação de pagamento (somente desenvolvimento e testes). */
export function sandboxApprove(reference: string, paidMethod: 'pix' | 'card' = 'pix'): SandboxPayment | null {
  const p = [...payments.values()].find((x) => x.reference === reference);
  if (!p) return null;
  p.status = 'approved'; p.paidMethod = paidMethod;
  return p;
}
export function sandboxReset() { payments.clear(); }

const view = (p: SandboxPayment): ProviderPayment => ({
  id: p.id, rawStatus: p.status, status: p.refundedCents >= p.amountCents ? 'refunded' : p.status, amountCents: p.amountCents, externalReference: p.reference,
  paidMethod: p.paidMethod, refundedCents: p.refundedCents,
});

export class SandboxPaymentGateway implements PaymentGateway {
  readonly provider = 'sandbox' as const;

  async createPix(i: CreateInput): Promise<PixCreated> {
    if (!i.payerEmail) throw new AdapterError('E-mail do pagador é obrigatório no Pix', false, 'http_400');
    const id = `sandbox-pay-${randomUUID()}`;
    payments.set(id, { id, reference: i.externalReference, amountCents: i.amountCents, status: 'pending', paidMethod: 'pix', refunded: false, refundedCents: 0, method: 'pix' });
    return { providerPaymentId: id, status: 'pending', qrCode: `00020126SANDBOX-NAO-PAGAVEL-${i.externalReference}`, qrCodeBase64: null };
  }
  async createCheckoutLink(i: CreateInput): Promise<LinkCreated> {
    // No link o id do pagamento só existe depois de pago: o sandbox cria o pagamento já ligado à referência.
    const id = `sandbox-pay-${randomUUID()}`;
    payments.set(id, { id, reference: i.externalReference, amountCents: i.amountCents, status: 'pending', paidMethod: 'card', refunded: false, refundedCents: 0, method: 'link' });
    return { checkoutUrl: `https://sandbox.invalid/checkout/${i.externalReference}` };
  }
  async getPayment(id: string) { const p = payments.get(id); return p ? view(p) : null; }
  async findByReference(ref: string) { const p = [...payments.values()].find((x) => x.reference === ref); return p ? view(p) : null; }
  async cancel(id: string) { const p = payments.get(id); if (p && p.status === 'pending') p.status = 'cancelled'; }
  async refund(id: string, _key?: string, amountCents?: number) {
    const p = payments.get(id);
    if (!p || p.status !== 'approved') throw new AdapterError('Pagamento não pode ser estornado (sandbox)', false, 'http_400');
    const amount = amountCents ?? p.amountCents - p.refundedCents;
    if (amount < 1 || amount > p.amountCents - p.refundedCents) throw new AdapterError('Valor de estorno inválido (sandbox)', false, 'http_400');
    p.refundedCents += amount;
    p.refunded = p.refundedCents >= p.amountCents;
  }
}
