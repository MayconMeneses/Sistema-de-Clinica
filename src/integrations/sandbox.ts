import { randomUUID } from 'node:crypto';
import { AdapterError, type Channel, type MessageAdapter, type OutboundMessage, type SendResult } from './types.js';

/** Mensagens "enviadas" no sandbox (somente memória, para desenvolvimento e testes). Nada sai da máquina. */
export const sandboxSent: { at: string; channel: Channel; templateName: string; toMasked: string; body?: string }[] = [];

const mask = (to: string) => (to.includes('@') ? to.replace(/^(.).*(@.*)$/, '$1***$2') : to.replace(/\d(?=\d{2})/g, '*'));

/**
 * Adaptador de sandbox: simula um provedor sem rede.
 * Destinatários especiais para demonstrar falhas: terminando em 0000 → erro definitivo; terminando em 0001 → erro transitório.
 */
export class SandboxAdapter implements MessageAdapter {
  readonly provider = 'sandbox';
  constructor(private channel: Channel) {}
  configured() { return true; }
  async send(m: OutboundMessage): Promise<SendResult> {
    if (/0000$/.test(m.to) || m.to.startsWith('fail-permanent')) throw new AdapterError('Destinatário recusado (sandbox)', false, 'sandbox_rejected');
    if (/0001$/.test(m.to) || m.to.startsWith('fail-temporary')) throw new AdapterError('Indisponibilidade simulada (sandbox)', true, 'sandbox_unavailable');
    // Só fora de produção: o link de redefinição aparece no log do worker (docker compose logs worker) porque nenhum e-mail sai de verdade.
    const dev = m.templateName === 'password_reset' && process.env.NODE_ENV !== 'production';
    if (dev) console.log(`[sandbox e-mail] para ${mask(m.to)}: ${m.body.match(/https?:\/\/\S+/)?.[0] ?? ''}`);
    sandboxSent.push({ at: new Date().toISOString(), channel: this.channel, templateName: m.templateName, toMasked: mask(m.to), ...(dev ? { body: m.body } : {}) });
    if (sandboxSent.length > 200) sandboxSent.shift();
    return { externalId: `sandbox-${randomUUID()}` };
  }
}
