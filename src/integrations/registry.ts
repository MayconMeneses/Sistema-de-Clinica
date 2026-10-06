import { SandboxAdapter } from './sandbox.js';
import { EmailHttpAdapter, SmsHttpAdapter, WhatsAppCloudAdapter } from './providers.js';
import type { Channel, MessageAdapter } from './types.js';

export type Mode = 'disabled' | 'sandbox' | 'live';
type Resolver = (channel: Channel, mode: Exclude<Mode, 'disabled'>) => MessageAdapter;

/** Provedor real por canal (um por canal nesta fase). */
export const LIVE_PROVIDERS: Record<Channel, MessageAdapter> = {
  whatsapp: new WhatsAppCloudAdapter(),
  email: new EmailHttpAdapter(),
  sms: new SmsHttpAdapter(),
};

let override: Resolver | null = null;
/** Somente testes: troca a resolução de adaptadores (ex.: falhas controladas). */
export function setAdapterOverride(fn: Resolver | null) { override = fn; }

export function resolveAdapter(channel: Channel, mode: Exclude<Mode, 'disabled'>): MessageAdapter {
  if (override) return override(channel, mode);
  return mode === 'sandbox' ? new SandboxAdapter(channel) : LIVE_PROVIDERS[channel];
}

/** Estado de cada integração para o painel da plataforma (sem expor valores de credenciais). */
export function integrationHealth() {
  return [
    ...(['whatsapp', 'email', 'sms'] as Channel[]).map((kind) => ({ kind, provider: LIVE_PROVIDERS[kind].provider, configured: LIVE_PROVIDERS[kind].configured(), implemented: true, validatedWithProvider: false })),
    ...['payments', 'storage', 'calendar', 'nfse', 'signature'].map((kind) => ({ kind, provider: kind === 'storage' ? 'local-fs' : 'não definido', configured: kind === 'storage', implemented: kind === 'storage', validatedWithProvider: false })),
  ];
}
