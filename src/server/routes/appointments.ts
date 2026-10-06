import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute, type ClinicCtx } from '../context.js';
import { hasPermission } from '../auth/rbac.js';
import { enqueueAppointmentMessages } from '../../modules/communications/enqueue.js';
import { assertActive } from '../../modules/patients/family.js';
import { badRequest, conflict, forbidden, HttpError, mapDbError, notFound } from '../http.js';

/** Fila da recepção: chegou → chamado → em atendimento → concluído. Voltar para a fila é permitido a quem foi chamado. */
const TRANSITIONS: Record<string, string[]> = {
  scheduled: ['confirmed', 'checked_in', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['called', 'in_service', 'completed', 'cancelled'],
  called: ['in_service', 'checked_in', 'cancelled', 'no_show'],
  in_service: ['completed'],
  completed: [], cancelled: [], no_show: [],
};
/** Colunas de tempo por status (texto fixo: nada vem do cliente). */
const STATUS_STAMP: Record<string, string> = {
  checked_in: ', checked_in_at = now()', called: ', called_at = now()',
  in_service: ', started_at = COALESCE(started_at, now())', completed: ', completed_at = now()',
};

export const APPT_SELECT = `a.id, a.starts_at AS "startsAt", a.ends_at AS "endsAt", a.status, a.service,
  a.price_cents AS "priceCents", a.cancel_reason AS "cancelReason", a.priority, a.series_id AS "seriesId", a.outside_hours AS "outsideHours",
  a.checked_in_at AS "checkedInAt", a.called_at AS "calledAt", a.started_at AS "startedAt",
  a.patient_id AS "patientId", p.name AS "patientName", a.professional_id AS "professionalId", u.name AS "professionalName",
  a.resource_id AS "resourceId", r.name AS "resourceName"`;
export const APPT_FROM = `FROM appointments a
  JOIN patients p ON p.tenant_id = a.tenant_id AND p.id = a.patient_id
  JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.professional_id
  LEFT JOIN resources r ON r.tenant_id = a.tenant_id AND r.id = a.resource_id`;

const iso = z.string().datetime({ offset: true });

// Horários de atendimento são avaliados no fuso de São Paulo (UTC−3, sem horário de verão).
// LIMITAÇÃO: o fuso por unidade (units.timezone) ainda não é usado.
const OFFSET_MS = -3 * 3600_000;
function localParts(d: Date) {
  const l = new Date(d.getTime() + OFFSET_MS);
  return { weekday: l.getUTCDay(), min: l.getUTCHours() * 60 + l.getUTCMinutes(), ymd: l.toISOString().slice(0, 10) };
}

/** Sem regras cadastradas = sem restrição. Com regras, a consulta precisa caber inteira numa janela do dia da semana. */
async function withinAvailability(ctx: ClinicCtx, professionalId: string, start: Date, end: Date): Promise<boolean> {
  const rules = await ctx.tx.query<{ weekday: number; start_min: number; end_min: number }>(
    'SELECT weekday, start_min, end_min FROM availability_rules WHERE professional_id = $1', [professionalId]);
  if (!rules.rowCount) return true;
  const s = localParts(start), e = localParts(end);
  let endMin = e.min;
  if (e.ymd !== s.ymd) { if (e.min !== 0) return false; endMin = 1440; }   // termina à meia-noite exata
  return rules.rows.some((r) => r.weekday === s.weekday && s.min >= r.start_min && endMin <= r.end_min);
}

interface NewAppt {
  patientId: string; professionalId: string; resourceId: string | null;
  startsAt: Date; endsAt: Date; service: string; priceCents: number; seriesId: string | null;
}

async function checkRefs(ctx: ClinicCtx, professionalId: string, resourceId: string | null, patientId?: string) {
  if (patientId) await assertActive(ctx.tx, patientId);
  const pro = await ctx.tx.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'professional' AND status = 'active'`, [professionalId]);
  if (!pro.rowCount) throw badRequest('Profissional inválido.');
  if (resourceId) {
    const r = await ctx.tx.query('SELECT 1 FROM resources WHERE id = $1', [resourceId]);
    if (!r.rowCount) throw badRequest('Sala ou equipamento inválido.');
  }
}

async function bookOne(ctx: ClinicCtx, b: NewAppt, encaixe: boolean): Promise<string> {
  const within = await withinAvailability(ctx, b.professionalId, b.startsAt, b.endsAt);
  if (!within && !encaixe) throw new HttpError(400, 'Fora do horário de atendimento do profissional. A recepção pode registrar como encaixe.', 'outside_hours');
  const r = await ctx.tx.query<{ id: string }>(
    `INSERT INTO appointments (tenant_id, patient_id, professional_id, resource_id, starts_at, ends_at, service, price_cents, series_id, outside_hours, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [ctx.tenantId, b.patientId, b.professionalId, b.resourceId, b.startsAt, b.endsAt, b.service, b.priceCents, b.seriesId, !within, ctx.user.id]);
  return r.rows[0]!.id;
}

const baseBody = z.object({
  patientId: z.string().uuid(), professionalId: z.string().uuid(),
  resourceId: z.string().uuid().nullish().transform((v) => v ?? null),
  startsAt: iso, endsAt: iso,
  service: z.string().trim().min(2).max(120).default('Consulta'),
  priceCents: z.number().int().min(0).max(100_000_000).default(0),
  encaixe: z.boolean().default(false),
});

function needOverride(ctx: ClinicCtx, encaixe: boolean) {
  if (encaixe && !hasPermission(ctx.user.role, 'schedule.override')) throw forbidden('Seu perfil não pode registrar encaixe fora do horário.');
}

export function appointmentRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/professionals', { cap: 'schedule.core', perm: 'agenda.read' }, async (ctx) => {
    const r = await ctx.tx.query(`SELECT id, name FROM users WHERE role = 'professional' AND status = 'active' ORDER BY name`);
    return { professionals: r.rows };
  });

  clinicRoute(app, 'GET', '/api/appointments', { cap: 'schedule.core', perm: 'agenda.read' }, async (ctx) => {
    const q = z.object({ from: iso, to: iso, professionalId: z.string().uuid().optional() }).parse(ctx.req.query);
    if (new Date(q.to).getTime() - new Date(q.from).getTime() > 62 * 86400_000) throw badRequest('Período máximo: 62 dias.');
    const r = await ctx.tx.query(
      `SELECT ${APPT_SELECT} ${APPT_FROM}
        WHERE a.starts_at >= $1 AND a.starts_at < $2 AND ($3::uuid IS NULL OR a.professional_id = $3)
        ORDER BY a.starts_at LIMIT 500`, [q.from, q.to, q.professionalId ?? null]);
    return { appointments: r.rows };
  });

  clinicRoute(app, 'POST', '/api/appointments', { cap: 'schedule.core', perm: 'agenda.write' }, async (ctx) => {
    const b = baseBody.parse(ctx.req.body);
    const startsAt = new Date(b.startsAt), endsAt = new Date(b.endsAt);
    if (endsAt <= startsAt) throw badRequest('O término deve ser depois do início.');
    needOverride(ctx, b.encaixe);
    await checkRefs(ctx, b.professionalId, b.resourceId, b.patientId);
    try {
      const id = await bookOne(ctx, { ...b, startsAt, endsAt, seriesId: null }, b.encaixe);
      await audit(ctx, 'appointment.create', 'appointment', id);
      await enqueueAppointmentMessages(ctx, { id, patientId: b.patientId, startsAt: b.startsAt }, 'confirmation');
      return { id };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return mapDbError(e);
    }
  });

  // Série (ex.: sessões semanais). Tudo-ou-nada por padrão; com skipConflicts cria o que der e informa o resto.
  clinicRoute(app, 'POST', '/api/appointments/series', { cap: 'schedule.core', perm: 'agenda.write' }, async (ctx) => {
    const b = baseBody.extend({
      count: z.number().int().min(2).max(26),
      everyDays: z.number().int().min(1).max(60).default(7),
      skipConflicts: z.boolean().default(false),
    }).parse(ctx.req.body);
    const start = new Date(b.startsAt), end = new Date(b.endsAt);
    if (end <= start) throw badRequest('O término deve ser depois do início.');
    needOverride(ctx, b.encaixe);
    await checkRefs(ctx, b.professionalId, b.resourceId, b.patientId);

    const seriesId = randomUUID();
    const created: { id: string; startsAt: string }[] = [];
    const conflicts: { startsAt: string; reason: string }[] = [];
    for (let i = 0; i < b.count; i++) {
      const s = new Date(start.getTime() + i * b.everyDays * 86400_000), e = new Date(end.getTime() + i * b.everyDays * 86400_000);
      await ctx.tx.query('SAVEPOINT occurrence');
      try {
        const id = await bookOne(ctx, { ...b, startsAt: s, endsAt: e, seriesId }, b.encaixe);
        await ctx.tx.query('RELEASE SAVEPOINT occurrence');
        created.push({ id, startsAt: s.toISOString() });
      } catch (err) {
        await ctx.tx.query('ROLLBACK TO SAVEPOINT occurrence');
        let reason: string;
        if (err instanceof HttpError) reason = err.message;
        else { try { mapDbError(err); reason = 'erro'; } catch (m) { if (m instanceof HttpError) reason = m.message; else throw err; } }
        conflicts.push({ startsAt: s.toISOString(), reason });
      }
    }
    if (conflicts.length && !b.skipConflicts) {
      const dates = conflicts.map((c) => new Date(c.startsAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })).join(', ');
      throw conflict(`Conflito em ${conflicts.length} data(s): ${dates}. Nada foi agendado; ajuste ou escolha "pular datas com conflito".`);
    }
    if (!created.length) throw conflict('Nenhuma data disponível para esta série.');
    for (const [i, c] of created.entries()) {
      await enqueueAppointmentMessages(ctx, { id: c.id, patientId: b.patientId, startsAt: c.startsAt }, i === 0 ? 'confirmation' : 'reminder_only');
    }
    await audit(ctx, 'appointment.series', 'appointment', created[0]!.id, { seriesId, created: created.length, skipped: conflicts.length });
    return { seriesId, created: created.length, conflicts };
  });

  clinicRoute(app, 'PATCH', '/api/appointments/:id', { cap: 'schedule.core', perm: 'agenda.write' }, async (ctx) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(ctx.req.params);
    const b = z.object({
      status: z.enum(['confirmed', 'checked_in', 'called', 'in_service', 'completed', 'cancelled', 'no_show']).optional(),
      reason: z.string().trim().min(3).max(300).optional(),
      priority: z.enum(['normal', 'priority']).optional(),
      startsAt: iso.optional(), endsAt: iso.optional(),
      encaixe: z.boolean().default(false),
    }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ status: string; price_cents: string; patient_id: string; professional_id: string }>(
      'SELECT status, price_cents, patient_id, professional_id FROM appointments WHERE id = $1 FOR UPDATE', [id]);
    const appt = cur.rows[0];
    if (!appt) throw notFound('Agendamento não encontrado.');

    try {
      if (b.startsAt || b.endsAt) {
        if (!b.startsAt || !b.endsAt) throw badRequest('Informe início e término.');
        if (!['scheduled', 'confirmed'].includes(appt.status)) throw conflict('Só é possível reagendar consultas agendadas ou confirmadas.');
        const s = new Date(b.startsAt), e = new Date(b.endsAt);
        if (e <= s) throw badRequest('O término deve ser depois do início.');
        needOverride(ctx, b.encaixe);
        const within = await withinAvailability(ctx, appt.professional_id, s, e);
        if (!within && !b.encaixe) throw new HttpError(400, 'Fora do horário de atendimento do profissional. A recepção pode registrar como encaixe.', 'outside_hours');
        await ctx.tx.query('UPDATE appointments SET starts_at = $1, ends_at = $2, outside_hours = $3 WHERE id = $4', [b.startsAt, b.endsAt, !within, id]);
        await audit(ctx, 'appointment.reschedule', 'appointment', id);
        await enqueueAppointmentMessages(ctx, { id, patientId: appt.patient_id, startsAt: b.startsAt }, 'rescheduled');
      }
      if (b.status) {
        if (!TRANSITIONS[appt.status]?.includes(b.status)) throw conflict(`Não é possível mudar de "${appt.status}" para "${b.status}".`);
        if (b.status === 'cancelled' && !b.reason) throw badRequest('Informe o motivo do cancelamento.');
        await ctx.tx.query(
          `UPDATE appointments SET status = $1, cancel_reason = COALESCE($2, cancel_reason), priority = COALESCE($3, priority)${STATUS_STAMP[b.status] ?? ''} WHERE id = $4`,
          [b.status, b.reason ?? null, b.status === 'checked_in' ? b.priority ?? null : null, id]);
        if (b.status === 'completed' && BigInt(appt.price_cents) > 0n && ctx.entitlements.has('finance.basic')) {
          // Atendimento concluído gera a cobrança uma única vez (idempotente).
          await ctx.tx.query(
            `INSERT INTO financial_movements (tenant_id, patient_id, appointment_id, kind, amount_cents, note, idempotency_key, created_by)
             VALUES ($1,$2,$3,'charge',$4,'Atendimento concluído',$5,$6) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
            [ctx.tenantId, appt.patient_id, id, appt.price_cents, `appt:${id}:charge`, ctx.user.id]);
        }
        await audit(ctx, `appointment.${b.status}`, 'appointment', id);
        if (b.status === 'cancelled') {
          const when = await ctx.tx.query<{ starts_at: Date }>('SELECT starts_at FROM appointments WHERE id = $1', [id]);
          await enqueueAppointmentMessages(ctx, { id, patientId: appt.patient_id, startsAt: when.rows[0]!.starts_at.toISOString() }, 'cancelled');
        }
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return mapDbError(e);
    }
    return { ok: true };
  });
}
