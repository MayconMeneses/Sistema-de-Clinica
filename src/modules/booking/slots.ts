import type pg from 'pg';

// Horários de atendimento são avaliados no fuso de São Paulo (UTC−3, sem horário de verão), como na agenda.
const OFFSET_MS = -3 * 3600_000;

export interface SlotInput {
  ymd: string;                                            // dia local AAAA-MM-DD
  rules: { start_min: number; end_min: number }[];        // janelas do dia da semana
  slotMinutes: number;
  now: Date;
  minNoticeHours: number;
  maxDaysAhead: number;
  busy: { start: Date; end: Date }[];                     // consultas, bloqueios e consultas do próprio paciente
}

export const weekdayOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const localMidnightUtc = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`) - OFFSET_MS;

/** Horários livres de um dia: cabem inteiros numa janela de atendimento, respeitam antecedência e horizonte e não batem em nada ocupado. */
export function daySlots(i: SlotInput): Date[] {
  const base = localMidnightUtc(i.ymd);
  const earliest = i.now.getTime() + i.minNoticeHours * 3_600_000;
  const latest = i.now.getTime() + i.maxDaysAhead * 86_400_000;
  const len = i.slotMinutes * 60_000;
  const out: Date[] = [];
  for (const r of i.rules) {
    for (let m = r.start_min; m + i.slotMinutes <= r.end_min; m += i.slotMinutes) {
      const s = base + m * 60_000, e = s + len;
      if (s < earliest || s > latest) continue;
      if (i.busy.some((b) => b.start.getTime() < e && b.end.getTime() > s)) continue;
      out.push(new Date(s));
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

export interface BookingSettings { enabled: boolean; slotMinutes: number; minNoticeHours: number; maxDaysAhead: number; maxActivePerPatient: number; service: string }

/** Dentro de withTenant: o RLS limita tudo à clínica. Sem horários cadastrados para o profissional, não há o que oferecer. */
export async function loadSettings(tx: pg.PoolClient): Promise<BookingSettings> {
  const r = await tx.query<{ enabled: boolean; slot_minutes: number; min_notice_hours: number; max_days_ahead: number; max_active_per_patient: number; service: string }>(
    'SELECT enabled, slot_minutes, min_notice_hours, max_days_ahead, max_active_per_patient, service FROM portal_booking_settings');
  const s = r.rows[0];
  return s
    ? { enabled: s.enabled, slotMinutes: s.slot_minutes, minNoticeHours: s.min_notice_hours, maxDaysAhead: s.max_days_ahead, maxActivePerPatient: s.max_active_per_patient, service: s.service }
    : { enabled: false, slotMinutes: 30, minNoticeHours: 12, maxDaysAhead: 30, maxActivePerPatient: 2, service: 'Consulta' };
}

export async function freeSlots(tx: pg.PoolClient, s: BookingSettings, professionalId: string, ymd: string, patientFamily: string[], now = new Date()): Promise<Date[]> {
  const rules = await tx.query<{ start_min: number; end_min: number }>('SELECT start_min, end_min FROM availability_rules WHERE professional_id = $1 AND weekday = $2', [professionalId, weekdayOf(ymd)]);
  if (!rules.rowCount) return [];
  const from = new Date(localMidnightUtc(ymd)), to = new Date(from.getTime() + 86_400_000);
  const busy: { start: Date; end: Date }[] = [];
  const appts = await tx.query<{ starts_at: Date; ends_at: Date }>(
    `SELECT starts_at, ends_at FROM appointments WHERE status NOT IN ('cancelled','no_show') AND starts_at < $3 AND ends_at > $2 AND (professional_id = $1 OR patient_id = ANY($4::uuid[]))`,
    [professionalId, from, to, patientFamily]);
  for (const a of appts.rows) busy.push({ start: a.starts_at, end: a.ends_at });
  const blocks = await tx.query<{ starts_at: Date; ends_at: Date }>(
    `SELECT starts_at, ends_at FROM schedule_blocks WHERE starts_at < $3 AND ends_at > $2 AND (professional_id = $1 OR (professional_id IS NULL AND resource_id IS NULL))`, [professionalId, from, to]);
  for (const b of blocks.rows) busy.push({ start: b.starts_at, end: b.ends_at });
  return daySlots({ ymd, rules: rules.rows, slotMinutes: s.slotMinutes, now, minNoticeHours: s.minNoticeHours, maxDaysAhead: s.maxDaysAhead, busy });
}
