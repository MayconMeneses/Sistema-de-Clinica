import { integrationEnv } from '../server/config.js';
import { httpJson } from './http.js';
import { AdapterError, type MessageAdapter, type OutboundMessage, type SendResult } from './types.js';

/**
 * Adaptadores REAIS. Estado: ESCRITOS e testados apenas contra um servidor HTTP falso local
 * (classificação de erro, timeout, idempotência). NÃO foram validados contra os provedores reais:
 * isso depende de credenciais, de templates aprovados e de contrato — ver docs/INTEGRACOES.md.
 */

/** WhatsApp Business Platform (Cloud API da Meta). Exige template aprovado com o mesmo nome. */
export class WhatsAppCloudAdapter implements MessageAdapter {
  readonly provider = 'whatsapp-cloud';
  configured() { const c = integrationEnv().whatsapp; return !!(c.token && c.phoneNumberId); }
  async send(m: OutboundMessage): Promise<SendResult> {
    const c = integrationEnv().whatsapp;
    if (!c.token || !c.phoneNumberId) throw new AdapterError('WhatsApp não configurado', true, 'not_configured');
    const { json } = await httpJson({
      url: `${c.apiBase}/${c.phoneNumberId}/messages`,
      headers: { authorization: `Bearer ${c.token}` },
      idempotencyKey: m.idempotencyKey,
      body: {
        messaging_product: 'whatsapp', to: m.to.replace(/\D/g, ''), type: 'template',
        template: { name: m.templateName, language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: m.vars.map((text) => ({ type: 'text', text })) }] },
      },
    });
    const id = (json.messages as { id?: string }[] | undefined)?.[0]?.id;
    if (!id) throw new AdapterError('Resposta do provedor sem identificador', false, 'bad_response');
    return { externalId: id };
  }
}

/** E-mail transacional via API HTTP genérica (POST JSON com Bearer). Ajustar ao provedor escolhido. */
export class EmailHttpAdapter implements MessageAdapter {
  readonly provider = 'email-http';
  configured() { const c = integrationEnv().email; return !!(c.apiUrl && c.apiKey && c.from); }
  async send(m: OutboundMessage): Promise<SendResult> {
    const c = integrationEnv().email;
    if (!c.apiUrl || !c.apiKey || !c.from) throw new AdapterError('E-mail não configurado', true, 'not_configured');
    const { json } = await httpJson({
      url: c.apiUrl, headers: { authorization: `Bearer ${c.apiKey}` }, idempotencyKey: m.idempotencyKey,
      body: { from: c.from, to: m.to, subject: m.subject ?? 'Aviso da clínica', text: m.body },
    });
    const id = (json.id ?? json.messageId) as string | undefined;
    if (!id) throw new AdapterError('Resposta do provedor sem identificador', false, 'bad_response');
    return { externalId: String(id) };
  }
}

/** SMS via API HTTP genérica. */
export class SmsHttpAdapter implements MessageAdapter {
  readonly provider = 'sms-http';
  configured() { const c = integrationEnv().sms; return !!(c.apiUrl && c.apiKey); }
  async send(m: OutboundMessage): Promise<SendResult> {
    const c = integrationEnv().sms;
    if (!c.apiUrl || !c.apiKey) throw new AdapterError('SMS não configurado', true, 'not_configured');
    const { json } = await httpJson({
      url: c.apiUrl, headers: { authorization: `Bearer ${c.apiKey}` }, idempotencyKey: m.idempotencyKey,
      body: { from: c.from, to: m.to, text: m.body },
    });
    const id = json.id as string | undefined;
    if (!id) throw new AdapterError('Resposta do provedor sem identificador', false, 'bad_response');
    return { externalId: String(id) };
  }
}
