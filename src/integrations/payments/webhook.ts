import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Mercado Pago: cabeçalho `x-signature: ts=<epoch>,v1=<hex>` e `x-request-id`.
 * Texto assinado (HMAC-SHA256 com o segredo do aplicativo): `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
 * Partes ausentes são omitidas. O id numérico/alfanumérico é comparado em minúsculas, como na documentação do provedor.
 * Janela de 10 min contra repetição; mesmo assim o processamento é idempotente e SEMPRE reconsulta o pagamento no provedor.
 */
export function verifyMercadoPago(secret: string, p: { signature?: string; requestId?: string; dataId?: string }, nowMs = Date.now(), windowSec = 600): boolean {
  if (!p.signature) return false;
  const parts = Object.fromEntries(p.signature.split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; })) as Record<string, string>;
  const ts = parts.ts, v1 = parts.v1;
  if (!ts || !v1 || !/^\d{9,13}$/.test(ts) || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  const tsSec = ts.length > 10 ? Number(ts) / 1000 : Number(ts); // alguns envios usam milissegundos
  if (Math.abs(nowMs / 1000 - tsSec) > windowSec) return false;
  const manifest = `${p.dataId ? `id:${p.dataId.toLowerCase()};` : ''}${p.requestId ? `request-id:${p.requestId};` : ''}ts:${ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'utf8'), b = Buffer.from(v1.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Gera a assinatura (usado só nos testes e no simulador local). */
export function signMercadoPago(secret: string, p: { requestId?: string; dataId?: string; ts: string }): string {
  const manifest = `${p.dataId ? `id:${p.dataId.toLowerCase()};` : ''}${p.requestId ? `request-id:${p.requestId};` : ''}ts:${p.ts};`;
  return `ts=${p.ts},v1=${createHmac('sha256', secret).update(manifest).digest('hex')}`;
}
