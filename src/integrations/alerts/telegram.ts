import { AdapterError } from '../types.js';

/**
 * Telegram Bot API — transporte REAL dos alertas. Estado: ESCRITO e testado contra um servidor HTTP falso local.
 * NÃO foi validado com o Telegram de verdade (falta o token do bot e o id do chat; ver docs/ALERTAS.md).
 * Endpoints: POST /bot<token>/sendMessage e /bot<token>/getUpdates (long polling, sem precisar de URL pública).
 * O token NUNCA aparece em mensagens de erro nem em log: toda falha vira AdapterError com texto fixo.
 */
export interface AlertTransport {
  readonly name: 'telegram' | 'sandbox';
  /** Envia o texto (HTML simples) para todos os chats autorizados. Falha em um chat não impede os outros. */
  send(text: string): Promise<{ delivered: number; failed: number }>;
  sendTo?(chatId: string, text: string): Promise<void>;
}

export interface TelegramUpdate { update_id: number; message?: { message_id: number; text?: string; chat: { id: number; type: string }; from?: { id: number } } }

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class TelegramClient {
  constructor(private token: string, private apiBase = 'https://api.telegram.org') {}

  private async call<T>(method: string, body: object, timeoutMs: number): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } };
      if (res.ok && json.ok) return json.result as T;
      const code = json.error_code ?? res.status;
      // 429 (limite) e 5xx são transitórios; 400/401/403/404 são definitivos (token errado, bot removido do chat, texto inválido).
      throw new AdapterError(`O Telegram respondeu ${code}`, code === 429 || code >= 500, `tg_${code}`);
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      if ((e as Error).name === 'AbortError') throw new AdapterError('Tempo esgotado ao chamar o Telegram', true, 'timeout');
      throw new AdapterError('Falha de rede ao chamar o Telegram', true, 'network');
    } finally { clearTimeout(timer); }
  }

  sendMessage(chatId: string, html: string) {
    return this.call('sendMessage', { chat_id: chatId, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }, 8000);
  }
  /** Long polling: o Telegram segura a chamada até haver mensagem (ou `timeoutSec`). */
  getUpdates(offset: number, timeoutSec = 25) {
    return this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, (timeoutSec + 10) * 1000);
  }
}

export class TelegramTransport implements AlertTransport {
  readonly name = 'telegram' as const;
  readonly client: TelegramClient;
  constructor(token: string, private chatIds: string[], apiBase?: string) { this.client = new TelegramClient(token, apiBase); }

  async sendTo(chatId: string, text: string) {
    try { await this.client.sendMessage(chatId, text); }
    catch (e) {
      // Uma nova tentativa para falha transitória; o resto fica para o próximo alerta.
      if (e instanceof AdapterError && e.retryable) { await new Promise((r) => setTimeout(r, 1500)); await this.client.sendMessage(chatId, text); } else throw e;
    }
  }
  async send(text: string) {
    let delivered = 0, failed = 0;
    for (const id of this.chatIds) {
      try { await this.sendTo(id, text); delivered++; } catch { failed++; }
      if (this.chatIds.length > 1) await new Promise((r) => setTimeout(r, 1100)); // limite do Telegram: ~1 mensagem por segundo por chat/grupo
    }
    return { delivered, failed };
  }
}

/** Sandbox: guarda as mensagens em memória (desenvolvimento e testes). Nada sai da máquina. */
export const sandboxAlerts: { at: string; text: string }[] = [];
export class SandboxAlertTransport implements AlertTransport {
  readonly name = 'sandbox' as const;
  async send(text: string) {
    sandboxAlerts.push({ at: new Date().toISOString(), text });
    if (sandboxAlerts.length > 100) sandboxAlerts.shift();
    return { delivered: 1, failed: 0 };
  }
}
