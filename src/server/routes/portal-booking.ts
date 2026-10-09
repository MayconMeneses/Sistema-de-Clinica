import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadSettings } from '../../modules/booking/slots.js';
import { audit, clinicRoute } from '../context.js';
import { badRequest } from '../http.js';

const CAP = { cap: 'patient.portal' } as const;

/** Configuração do agendamento online pelo portal (equipe com acesso ao portal). */
export function portalBookingRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/portal-booking', { ...CAP, perm: 'portal.manage' }, async (ctx) => {
    const s = await loadSettings(ctx.tx);
    const pros = await ctx.tx.query(
      `SELECT u.id, u.name, (b.professional_id IS NOT NULL) AS bookable, EXISTS (SELECT 1 FROM availability_rules r WHERE r.professional_id = u.id) AS "hasHours"
         FROM users u LEFT JOIN portal_bookable_professionals b ON b.tenant_id = u.tenant_id AND b.professional_id = u.id
        WHERE u.role = 'professional' AND u.status = 'active' ORDER BY u.name`);
    return { settings: s, professionals: pros.rows, scheduleAvailable: ctx.entitlements.has('schedule.core') };
  });

  clinicRoute(app, 'PUT', '/api/portal-booking', { ...CAP, perm: 'portal.manage' }, async (ctx) => {
    const b = z.object({
      enabled: z.boolean(),
      slotMinutes: z.number().int().min(10).max(240), minNoticeHours: z.number().int().min(0).max(168),
      maxDaysAhead: z.number().int().min(1).max(180), maxActivePerPatient: z.number().int().min(1).max(10),
      service: z.string().trim().min(2).max(120),
      professionalIds: z.array(z.string().uuid()).max(100),
    }).strict().parse(ctx.req.body);
    if (b.enabled && !ctx.entitlements.has('schedule.core')) throw badRequest('O plano contratado não inclui agenda.');
    const ids = [...new Set(b.professionalIds)];
    if (ids.length) {
      const ok = await ctx.tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[]) AND role = 'professional' AND status = 'active'`, [ids]);
      if (ok.rows[0]!.n !== ids.length) throw badRequest('Profissional inválido.');
    }
    if (b.enabled && !ids.length) throw badRequest('Escolha ao menos um profissional para ligar o agendamento online.');
    await ctx.tx.query(
      `INSERT INTO portal_booking_settings (tenant_id, enabled, slot_minutes, min_notice_hours, max_days_ahead, max_active_per_patient, service) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id) DO UPDATE SET enabled = $2, slot_minutes = $3, min_notice_hours = $4, max_days_ahead = $5, max_active_per_patient = $6, service = $7, updated_at = now()`,
      [ctx.tenantId, b.enabled, b.slotMinutes, b.minNoticeHours, b.maxDaysAhead, b.maxActivePerPatient, b.service]);
    await ctx.tx.query('DELETE FROM portal_bookable_professionals WHERE NOT (professional_id = ANY($1::uuid[]))', [ids]);
    for (const id of ids) await ctx.tx.query('INSERT INTO portal_bookable_professionals (tenant_id, professional_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ctx.tenantId, id]);
    await audit(ctx, 'portal.booking_settings', 'portal_booking', undefined, { enabled: b.enabled, professionals: ids.length });
    return { ok: true };
  });
}
