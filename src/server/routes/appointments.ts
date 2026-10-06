import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute } from '../context.js';
import { badRequest, conflict, mapDbError, notFound } from '../http.js';

const TRANSITIONS: Record<string, string[]> = {
  scheduled: ['confirmed', 'checked_in', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['completed', 'cancelled'],
  completed: [], cancelled: [], no_show: [],
};

const SELECT = `a.id, a.starts_at AS "startsAt", a.ends_at AS "endsAt", a.status, a.service,
  a.price_cents AS "priceCents", a.cancel_reason AS "cancelReason",
  a.patient_id AS "patientId", p.name AS "patientName", a.professional_id AS "professionalId", u.name AS "professionalName"`;
const FROM = `FROM appointments a
  JOIN patients p ON p.tenant_id = a.tenant_id AND p.id = a.patient_id
  JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.professional_id`;

const iso = z.string().datetime({ offset: true });

export function appointmentRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/professionals', { cap: 'schedule.core', perm: 'agenda.read' }, async (ctx) => {
    const r = await ctx.tx.query(`SELECT id, name FROM users WHERE role = 'professional' AND status = 'active' ORDER BY name`);
    return { professionals: r.rows };
  });

  clinicRoute(app, 'GET', '/api/appointments', { cap: 'schedule.core', perm: 'agenda.read' }, async (ctx) => {
    const q = z.object({ from: iso, to: iso, professionalId: z.string().uuid().optional() }).parse(ctx.req.query);
    if (new Date(q.to).getTime() - new Date(q.from).getTime() > 62 * 86400_000) throw badRequest('Período máximo: 62 dias.');
    const r = await ctx.tx.query(
      `SELECT ${SELECT} ${FROM}
        WHERE a.starts_at >= $1 AND a.starts_at < $2 AND ($3::uuid IS NULL OR a.professional_id = $3)
        ORDER BY a.starts_at LIMIT 500`, [q.from, q.to, q.professionalId ?? null]);
    return { appointments: r.rows };
  });

  clinicRoute(app, 'POST', '/api/appointments', { cap: 'schedule.core', perm: 'agenda.write' }, async (ctx) => {
    const b = z.object({
      patientId: z.string().uuid(), professionalId: z.string().uuid(),
      startsAt: iso, endsAt: iso,
      service: z.string().trim().min(2).max(120).default('Consulta'),
      priceCents: z.number().int().min(0).max(100_000_000).default(0),
    }).parse(ctx.req.body);
    if (new Date(b.endsAt) <= new Date(b.startsAt)) throw badRequest('O término deve ser depois do início.');
    const pro = await ctx.tx.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'professional' AND status = 'active'`, [b.professionalId]);
    if (!pro.rowCount) throw badRequest('Profissional inválido.');
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO appointments (tenant_id, patient_id, professional_id, starts_at, ends_at, service, price_cents, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.tenantId, b.patientId, b.professionalId, b.startsAt, b.endsAt, b.service, b.priceCents, ctx.user.id]);
      await audit(ctx, 'appointment.create', 'appointment', r.rows[0]!.id);
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'PATCH', '/api/appointments/:id', { cap: 'schedule.core', perm: 'agenda.write' }, async (ctx) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(ctx.req.params);
    const b = z.object({
      status: z.enum(['confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']).optional(),
      reason: z.string().trim().min(3).max(300).optional(),
      startsAt: iso.optional(), endsAt: iso.optional(),
    }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ status: string; price_cents: string; patient_id: string }>(
      'SELECT status, price_cents, patient_id FROM appointments WHERE id = $1 FOR UPDATE', [id]);
    const appt = cur.rows[0];
    if (!appt) throw notFound('Agendamento não encontrado.');

    try {
      if (b.startsAt || b.endsAt) {
        if (!b.startsAt || !b.endsAt) throw badRequest('Informe início e término.');
        if (!['scheduled', 'confirmed'].includes(appt.status)) throw conflict('Só é possível reagendar consultas agendadas ou confirmadas.');
        if (new Date(b.endsAt) <= new Date(b.startsAt)) throw badRequest('O término deve ser depois do início.');
        await ctx.tx.query('UPDATE appointments SET starts_at = $1, ends_at = $2 WHERE id = $3', [b.startsAt, b.endsAt, id]);
        await audit(ctx, 'appointment.reschedule', 'appointment', id);
      }
      if (b.status) {
        if (!TRANSITIONS[appt.status]?.includes(b.status)) throw conflict(`Não é possível mudar de "${appt.status}" para "${b.status}".`);
        if (b.status === 'cancelled' && !b.reason) throw badRequest('Informe o motivo do cancelamento.');
        await ctx.tx.query('UPDATE appointments SET status = $1, cancel_reason = COALESCE($2, cancel_reason) WHERE id = $3', [b.status, b.reason ?? null, id]);
        if (b.status === 'completed' && BigInt(appt.price_cents) > 0n && ctx.entitlements.has('finance.basic')) {
          // Atendimento concluído gera a cobrança uma única vez (idempotente).
          await ctx.tx.query(
            `INSERT INTO financial_movements (tenant_id, patient_id, appointment_id, kind, amount_cents, note, idempotency_key, created_by)
             VALUES ($1,$2,$3,'charge',$4,'Atendimento concluído',$5,$6) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
            [ctx.tenantId, appt.patient_id, id, appt.price_cents, `appt:${id}:charge`, ctx.user.id]);
        }
        await audit(ctx, `appointment.${b.status}`, 'appointment', id);
      }
    } catch (e) {
      if ((e as { status?: number }).status) throw e;
      return mapDbError(e);
    }
    return { ok: true };
  });
}
