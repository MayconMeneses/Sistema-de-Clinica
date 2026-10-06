export type Channel = 'whatsapp' | 'email' | 'sms';
export const CHANNELS: Channel[] = ['whatsapp', 'email', 'sms'];

export interface OutboundMessage {
  channel: Channel;
  to: string;
  subject?: string;
  body: string;
  templateName: string;
  /** Repassado ao provedor para evitar envio duplicado em retentativas. */
  idempotencyKey: string;
  vars: string[];
}
export interface SendResult { externalId: string }

/** retryable=true: erro transitório (rede, 429, 5xx, provedor não configurado ainda). false: definitivo (4xx). */
export class AdapterError extends Error {
  constructor(message: string, public retryable: boolean, public code: string) { super(message); }
}

export interface MessageAdapter {
  readonly provider: string;
  configured(): boolean;
  send(m: OutboundMessage): Promise<SendResult>;
}
