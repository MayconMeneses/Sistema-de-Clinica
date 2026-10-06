import type pg from 'pg';
import { withTenant } from '../../db/tenant.js';
import { integrationEnv } from '../../server/config.js';
import { resolveAdapter, type Mode } from '../../integrations/registry.js';
import { AdapterError, CHANNELS, type Channel } from '../../integrations/types.js';
import { isTemplate, renderTemplate, whenLabel } from './templates.js';

export interface OutboxRow { id: string; tenant_id: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }
export type Outcome =
  | { kind: 'sent'; externalId: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'retry'; code: string; message: string }
  | { kind: 'dead'; code: string; message: string };

const PURPOSE: Record<Channel, string> = { whatsapp: 'communication_whatsapp', email: 'communication_email', sms: 'communication_sms' };
const ACTIVE = ['scheduled', 'confirmed', 'checked_in'];

/** Remove números longos e e-mails de mensagens de erro antes de gravar (sem dado pessoal em last_error). */
export function sanitizeError(s: string): string {
  return s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]').replace(/\d{6,}/g, '#').slice(0, 200);
}

/**
 * Processa uma mensagem. Os dados do paciente são lidos AGORA, sob o contexto do tenant do evento
 * (o worker não guarda telefone/e-mail na fila): consentimento revogado ou consulta alterada após o
 * enfileiramento resultam em "skipped", nunca em envio indevido.
 */
export async function handleMessage(appPool: pg.Pool, ev: OutboxRow): Promise<Outcome> {
  const p = ev.payload as { channel?: string; template?: string; patientId?: string; appointmentId?: string; startsAt?: string };
  if (!p.channel || !CHANNELS.includes(p.channel as Channel) || !p.template || !isTemplate(p.template) || !p.patientId) {
    return { kind: 'dead', code: 'bad_payload', message: 'Evento malformado' };
  }
  const channel = p.channel as Channel;
  const template = p.template;

  const data = await withTenant(appPool, ev.tenant_id, async (tx) => {
    const patient = await tx.query<{ name: string; social_name: string | null; phone: string | null; email: string | null }>(
      'SELECT name, social_name, phone, email FROM patients WHERE id = $1', [p.patientId]);
    if (!patient.rows[0]) return null;
    const consent = await tx.query<{ granted: boolean }>(
      'SELECT granted FROM patient_consents WHERE patient_id = $1 AND purpose = $2 ORDER BY seq DESC LIMIT 1', [p.patientId, PURPOSE[channel]]);
    const conn = await tx.query<{ mode: Mode }>('SELECT mode FROM integration_connections WHERE kind = $1', [channel]);
    const clinic = await tx.query<{ name: string }>('SELECT name FROM tenants');
    let appt: { status: string; starts_at: Date; professional: string } | null = null;
    if (p.appointmentId) {
      const a = await tx.query<{ status: string; starts_at: Date; professional: string }>(
        `SELECT a.status, a.starts_at, u.name AS professional FROM appointments a JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.professional_id WHERE a.id = $1`, [p.appointmentId]);
      appt = a.rows[0] ?? null;
    }
    return { patient: patient.rows[0], consent: consent.rows[0]?.granted === true, mode: conn.rows[0]?.mode ?? integrationEnv().defaultMode, clinic: clinic.rows[0]?.name ?? 'Clínica', appt };
  });

  if (!data) return { kind: 'dead', code: 'patient_not_found', message: 'Paciente não encontrado neste tenant' };
  if (data.mode === 'disabled') return { kind: 'skipped', reason: 'integration_disabled' };
  if (!data.consent) return { kind: 'skipped', reason: 'no_consent' };
  const to = channel === 'email' ? data.patient.email : data.patient.phone;
  if (!to) return { kind: 'skipped', reason: 'no_contact' };

  if (p.appointmentId && template !== 'appointment_cancelled') {
    const same = data.appt && p.startsAt && data.appt.starts_at.getTime() === new Date(p.startsAt).getTime();
    if (!data.appt || !ACTIVE.includes(data.appt.status) || !same) return { kind: 'skipped', reason: 'appointment_changed' };
  }

  const when = data.appt ? whenLabel(data.appt.starts_at.toISOString()) : p.startsAt ? whenLabel(p.startsAt) : '';
  const msg = renderTemplate(template, { patient: data.patient.social_name ?? data.patient.name, clinic: data.clinic, professional: data.appt?.professional ?? 'a equipe', when });
  try {
    const adapter = resolveAdapter(channel, data.mode);
    const r = await adapter.send({ channel, to, subject: msg.subject, body: msg.body, templateName: template, idempotencyKey: ev.id, vars: msg.vars });
    return { kind: 'sent', externalId: r.externalId };
  } catch (e) {
    if (e instanceof AdapterError) return e.retryable ? { kind: 'retry', code: e.code, message: sanitizeError(e.message) } : { kind: 'dead', code: e.code, message: sanitizeError(e.message) };
    return { kind: 'retry', code: 'unexpected', message: 'Erro inesperado ao enviar' };
  }
}
