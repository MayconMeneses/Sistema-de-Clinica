import { randomUUID } from 'node:crypto';
import { AdapterError } from './types.js';

/**
 * Assinatura eletrônica (ex.: aceite de orçamento, termos, receituário). PORTA e SANDBOX prontos; adaptador real PENDENTE:
 * depende do provedor escolhido (nível de assinatura e validade jurídica a validar com especialista) e de contrato.
 * Hoje o aceite do orçamento é um REGISTRO feito pela clínica, e a tela diz que isso não é assinatura eletrônica.
 */
export interface SignatureSigner { name: string; email: string; role: 'patient' | 'guardian' | 'professional' }
export interface SignatureRequestInput {
  idempotencyKey: string;
  documentName: string;
  /** Hash do documento (o conteúdo em si não precisa sair do sistema para criar o pedido). */
  documentSha256: string;
  signers: SignatureSigner[];
}
export interface SignatureRequestCreated { requestId: string; signUrls: Record<string, string> }
export type SignatureStatus = 'pending' | 'signed' | 'refused' | 'expired';
export interface SignatureProvider {
  readonly provider: string;
  configured(): boolean;
  createRequest(i: SignatureRequestInput): Promise<SignatureRequestCreated>;
  getStatus(requestId: string): Promise<{ status: SignatureStatus; signedAt: string | null }>;
}

const requests = new Map<string, { idem: string; status: SignatureStatus; signedAt: string | null }>();
/** Simula a assinatura (somente desenvolvimento e testes). */
export function sandboxSign(requestId: string) {
  const r = requests.get(requestId);
  if (!r) return false;
  r.status = 'signed'; r.signedAt = new Date().toISOString();
  return true;
}

export class SandboxSignature implements SignatureProvider {
  readonly provider = 'sandbox';
  configured() { return true; }
  async createRequest(i: SignatureRequestInput): Promise<SignatureRequestCreated> {
    if (!/^[0-9a-f]{64}$/.test(i.documentSha256) || i.signers.length === 0) throw new AdapterError('Pedido inválido (sandbox)', false, 'sandbox_rejected');
    const existing = [...requests.entries()].find(([, v]) => v.idem === i.idempotencyKey);
    const requestId = existing?.[0] ?? `sandbox-sig-${randomUUID()}`;
    if (!existing) requests.set(requestId, { idem: i.idempotencyKey, status: 'pending', signedAt: null });
    return { requestId, signUrls: Object.fromEntries(i.signers.map((s) => [s.email, `https://sandbox.invalid/sign/${requestId}`])) };
  }
  async getStatus(id: string) {
    const r = requests.get(id);
    if (!r) throw new AdapterError('Pedido não encontrado (sandbox)', false, 'sandbox_not_found');
    return { status: r.status, signedAt: r.signedAt };
  }
}

export function resolveSignature(mode: 'sandbox' | 'live'): SignatureProvider {
  if (mode === 'live') throw new AdapterError('Assinatura eletrônica real ainda não foi implementada: depende do provedor escolhido.', false, 'not_implemented');
  return new SandboxSignature();
}
