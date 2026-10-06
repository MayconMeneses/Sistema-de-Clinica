import { createHmac, timingSafeEqual } from 'node:crypto';

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';
export interface NormalizedEvent { externalEventId: string; externalMessageId: string; status: DeliveryStatus }

const safeEqualHex = (a: string, b: string) => {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Formato genérico: HMAC-SHA256 hex de "<timestamp>.<corpo bruto>"; timestamp em segundos, janela de 5 min (anti-replay). */
export function verifyGeneric(secret: string, timestamp: string | undefined, rawBody: Buffer, signature: string | undefined, nowMs = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d{9,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature.replace(/^sha256=/, ''));
}

/** WhatsApp (Meta): cabeçalho X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, corpo bruto). Não há timestamp: o anti-replay é a deduplicação por evento. */
export function verifyMeta(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  return safeEqualHex(createHmac('sha256', appSecret).update(rawBody).digest('hex'), header.slice(7));
}

const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

/** Formato genérico: { events: [{ id, messageId, status }] } */
export function parseGeneric(json: unknown): NormalizedEvent[] {
  const events = (json as { events?: { id?: unknown; messageId?: unknown; status?: unknown }[] })?.events;
  if (!Array.isArray(events)) return [];
  return events.slice(0, 100).flatMap((e) =>
    typeof e.id === 'string' && typeof e.messageId === 'string' && typeof e.status === 'string' && STATUSES.has(e.status) && e.id.length <= 200 && e.messageId.length <= 200
      ? [{ externalEventId: e.id, externalMessageId: e.messageId, status: e.status as DeliveryStatus }] : []);
}

/** Meta: entry[].changes[].value.statuses[] { id, status, timestamp }. Guarda só id e status (sem telefone). */
export function parseMeta(json: unknown): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const entries = (json as { entry?: { changes?: { value?: { statuses?: { id?: string; status?: string }[] } }[] }[] })?.entry ?? [];
  for (const en of entries) for (const ch of en.changes ?? []) for (const st of ch.value?.statuses ?? []) {
    if (typeof st.id === 'string' && typeof st.status === 'string' && STATUSES.has(st.status)) {
      out.push({ externalEventId: `${st.id}:${st.status}`, externalMessageId: st.id, status: st.status as DeliveryStatus });
    }
  }
  return out.slice(0, 100);
}
