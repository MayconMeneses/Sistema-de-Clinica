import { INTEGRATION_CATALOG } from './catalog.js';
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

/** Estado de cada integração para o painel da plataforma (sem expor valores de credenciais). Vem do catálogo único. */
export function integrationHealth() {
  return INTEGRATION_CATALOG.map((c) => ({
    kind: c.kind, label: c.label, provider: c.provider, scope: c.scope, env: c.env, pending: c.pending,
    configured: c.configured() === true, perClinic: c.configured() === null,
    implemented: c.liveAdapter !== 'none', portReady: c.port, sandbox: c.sandbox, validatedWithProvider: c.validatedWithProvider,
  }));
}
