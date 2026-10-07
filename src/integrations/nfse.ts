import { AdapterError } from './types.js';

/**
 * NFS-e (nota fiscal de serviço eletrônica). PORTA e SANDBOX prontos; adaptador real PENDENTE: depende do município
 * da clínica (cada prefeitura tem seu provedor/padrão), do certificado digital e da decisão fiscal do proprietário.
 * Nada no sistema emite nota hoje: o recibo é só comprovante e diz que não é documento fiscal.
 */
export interface NfseInput {
  idempotencyKey: string;
  takerName: string;
  takerDocument?: string | null;   // CPF/CNPJ do tomador (dado pessoal: só enviar com base legal)
  description: string;
  amountCents: number;
  municipalServiceCode: string;
}
export interface NfseIssued { number: string; verificationCode: string; pdfUrl: string | null }
export interface NfseProvider {
  readonly provider: string;
  configured(): boolean;
  emit(i: NfseInput): Promise<NfseIssued>;
  cancel(number: string, reason: string): Promise<void>;
}

const issued = new Map<string, NfseIssued & { canceled: boolean }>();
let counter = 0;

/** Sandbox: numera notas fictícias (homologação), sem nenhum efeito fiscal. */
export class SandboxNfse implements NfseProvider {
  readonly provider = 'sandbox';
  configured() { return true; }
  async emit(i: NfseInput): Promise<NfseIssued> {
    if (i.amountCents <= 0) throw new AdapterError('Valor inválido (sandbox)', false, 'sandbox_rejected');
    const prev = [...issued.entries()].find(([k]) => k === i.idempotencyKey);
    if (prev) return prev[1];
    const n = { number: `HOMOLOG-${String(++counter).padStart(6, '0')}`, verificationCode: `SBX${counter}`, pdfUrl: null, canceled: false };
    issued.set(i.idempotencyKey, n);
    return n;
  }
  async cancel(number: string) {
    const n = [...issued.values()].find((x) => x.number === number);
    if (!n) throw new AdapterError('Nota não encontrada (sandbox)', false, 'sandbox_not_found');
    n.canceled = true;
  }
}

export function resolveNfse(mode: 'sandbox' | 'live'): NfseProvider {
  if (mode === 'live') throw new AdapterError('Emissão real de NFS-e ainda não foi implementada: depende do município e do provedor escolhidos.', false, 'not_implemented');
  return new SandboxNfse();
}
