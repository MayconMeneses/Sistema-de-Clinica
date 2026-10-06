import type pg from 'pg';
import { CHANNELS, type Channel } from '../../integrations/types.js';

export interface EnqueueCtx { tx: pg.PoolClient; tenantId: string; entitlements: Set<string> }
export type ApptMessageKind = 'confirmation' | 'cancelled' | 'rescheduled';

const TEMPLATE: Record<ApptMessageKind, string> = {
  confirmation: 'appointment_confirmation', cancelled: 'appointment_cancelled', rescheduled: 'appointment_rescheduled',
};
const PURPOSE: Record<Channel, string> = { whatsapp: 'communication_whatsapp', email: 'communication_email', sms: 'communication_sms' };

/** Primeiro canal com consentimento VIGENTE e contato cadastrado (WhatsApp > e-mail > SMS). */
export async function pickChannel(tx: pg.PoolClient, patientId: string): Promise<Channel | null> {
  const p = await tx.query<{ phone: string | null; email: string | null }>('SELECT phone, email FROM patients WHERE id = $1', [patientId]);
  if (!p.rows[0]) return null;
  const c = await tx.query<{ purpose: string; granted: boolean }>(
    `SELECT DISTINCT ON (purpose) purpose, granted FROM patient_consents WHERE patient_id = $1 ORDER BY purpose, seq DESC`, [patientId]);
  const granted = new Set(c.rows.filter((r) => r.granted).map((r) => r.purpose));
  for (const ch of CHANNELS) {
    const hasContact = ch === 'email' ? !!p.rows[0].email : !!p.rows[0].phone;
    if (granted.has(PURPOSE[ch]) && hasContact) return ch;
  }
  return null;
}

async function insert(ctx: EnqueueCtx, key: string, payload: object, opts: { status?: 'pending' | 'skipped'; reason?: string; at?: Date } = {}) {
  await ctx.tx.query(
    `INSERT INTO outbox_events (tenant_id, topic, payload, status, last_error, next_attempt_at, idempotency_key, processed_at)
     VALUES ($1,'message.send',$2,$3,$4,$5,$6, CASE WHEN $3 = 'skipped' THEN now() END)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [ctx.tenantId, JSON.stringify(payload), opts.status ?? 'pending', opts.reason ?? null, opts.at ?? new Date(), key]);
}

/**
 * Outbox transacional: roda na MESMA transação da agenda. Se a transação falhar, nada é enfileirado;
 * se der certo, a mensagem existe e será enviada pelo worker (com retry), nunca antes do commit.
 * Sem consentimento/contato, registra "skipped" para a clínica ver por que não houve envio.
 */
export async function enqueueAppointmentMessages(ctx: EnqueueCtx, a: { id: string; patientId: string; startsAt: string }, kind: ApptMessageKind) {
  if (!ctx.entitlements.has('communication.inbox')) return;
  const epoch = Math.floor(new Date(a.startsAt).getTime() / 1000);
  const base = { patientId: a.patientId, appointmentId: a.id, startsAt: new Date(a.startsAt).toISOString() };
  const channel = await pickChannel(ctx.tx, a.patientId);
  if (!channel) {
    await insert(ctx, `appt:${a.id}:${kind}:${epoch}`, { ...base, channel: null, template: TEMPLATE[kind] }, { status: 'skipped', reason: 'no_consent' });
    return;
  }
  await insert(ctx, kind === 'cancelled' ? `appt:${a.id}:cancelled` : `appt:${a.id}:${kind}:${epoch}`, { ...base, channel, template: TEMPLATE[kind] });
  if (kind !== 'cancelled') {
    const remindAt = new Date(new Date(a.startsAt).getTime() - 24 * 3600_000);
    if (remindAt.getTime() > Date.now()) {
      await insert(ctx, `appt:${a.id}:reminder:${epoch}`, { ...base, channel, template: 'appointment_reminder' }, { at: remindAt });
    }
  }
}
