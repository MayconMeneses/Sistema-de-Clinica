import { AdapterError } from './types.js';

export interface HttpJsonOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
  /** Nome do cabeçalho de idempotência (padrão: Idempotency-Key; o Mercado Pago usa X-Idempotency-Key). */
  idempotencyHeader?: string;
}

/**
 * Chamada HTTP com timeout e classificação de erro. Mensagens de erro NUNCA incluem o corpo da
 * requisição nem da resposta (podem conter telefone, e-mail ou texto clínico).
 */
export async function httpJson(o: HttpJsonOptions): Promise<{ status: number; json: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 8000);
  try {
    const res = await fetch(o.url, {
      method: o.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...(o.idempotencyKey ? { [o.idempotencyHeader ?? 'idempotency-key']: o.idempotencyKey } : {}), ...o.headers },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { status: res.status, json };
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    throw new AdapterError(`O provedor respondeu HTTP ${res.status}`, retryable, `http_${res.status}`);
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    if ((e as Error).name === 'AbortError') throw new AdapterError('Tempo esgotado ao chamar o provedor', true, 'timeout');
    throw new AdapterError('Falha de rede ao chamar o provedor', true, 'network');
  } finally {
    clearTimeout(timer);
  }
}
