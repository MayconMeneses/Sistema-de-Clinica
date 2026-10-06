import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute } from '../context.js';
import { APPT_FROM, APPT_SELECT } from './appointments.js';
import { assertActive } from '../../modules/patients/family.js';
import { badRequest, conflict, mapDbError, notFound } from '../http.js';

const CAP = { cap: 'schedule.core' } as const;
const idParam = z.object({ id: z.string().uuid() });
const iso = z.string().datetime({ offset: true });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM.');
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

export function scheduleRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ unidades e salas
  clinicRoute(app, 'GET', '/api/units', { ...CAP, perm: 'agenda.read' }, async (ctx) => {
    const r = await ctx.tx.query('SELECT id, name, timezone FROM units ORDER BY name');
    return { units: r.rows };
  });
  clinicRoute(app, 'POST', '/api/units', { ...CAP, perm: 'org.manage' }, async (ctx) => {
    const b = z.object({ name: z.string().trim().min(2).max(120) }).parse(ctx.req.body);
    const r = await ctx.tx.query<{ id: string }>('INSERT INTO units (tenant_id, name) VALUES ($1,$2) RETURNING id', [ctx.tenantId, b.name]);
    await audit(ctx, 'unit.create', 'unit', r.rows[0]!.id);
    return { id: r.rows[0]!.id };
  });
  clinicRoute(app, 'GET', '/api/resources', { ...CAP, perm: 'agenda.read' }, async (ctx) => {
    const r = await ctx.tx.query(`SELECT r.id, r.name, r.kind, r.unit_id AS "unitId", u.name AS "unitName" FROM resources r JOIN units u ON u.tenant_id = r.tenant_id AND u.id = r.unit_id ORDER BY u.name, r.name`);
    return { resources: r.rows };
  });
  clinicRoute(app, 'POST', '/api/resources', { ...CAP, perm: 'org.manage' }, async (ctx) => {
    const b = z.object({ unitId: z.string().uuid(), name: z.string().trim().min(1).max(80), kind: z.enum(['room', 'chair', 'equipment']) }).parse(ctx.req.body);
    try {
      const r = await ctx.tx.query<{ id: string }>('INSERT INTO resources (tenant_id, unit_id, name, kind) VALUES ($1,$2,$3,$4) RETURNING id', [ctx.tenantId, b.unitId, b.name, b.kind]);
      await audit(ctx, 'resource.create', 'resource', r.rows[0]!.id);
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });

  // ------------------------------------------------------------ horário de atendimento
  clinicRoute(app, 'GET', '/api/availability', { ...CAP, perm: 'agenda.read' }, async (ctx) => {
    const r = await ctx.tx.query(
      `SELECT a.id, a.professional_id AS "professionalId", u.name AS "professionalName", a.weekday,
              lpad((a.start_min / 60)::text, 2, '0') || ':' || lpad((a.start_min % 60)::text, 2, '0') AS "start",
              lpad((a.end_min / 60)::text, 2, '0') || ':' || lpad((a.end_min % 60)::text, 2, '0') AS "end"
         FROM availability_rules a JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.professional_id
        ORDER BY u.name, a.weekday, a.start_min`);
    return { rules: r.rows };
  });
  clinicRoute(app, 'POST', '/api/availability', { ...CAP, perm: 'schedule.manage' }, async (ctx) => {
    const b = z.object({ professionalId: z.string().uuid(), weekday: z.number().int().min(0).max(6), start: hhmm, end: hhmm }).parse(ctx.req.body);
    const s = toMin(b.start), e = toMin(b.end) === 0 ? 1440 : toMin(b.end);
    if (e <= s) throw badRequest('O fim deve ser depois do início.');
    const pro = await ctx.tx.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'professional'`, [b.professionalId]);
    if (!pro.rowCount) throw badRequest('Profissional inválido.');
    try {
      const r = await ctx.tx.query<{ id: string }>(
        'INSERT INTO availability_rules (tenant_id, professional_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4,$5) RETURNING id', [ctx.tenantId, b.professionalId, b.weekday, s, e]);
      await audit(ctx, 'availability.create', 'availability', r.rows[0]!.id);
      return { id: r.rows[0]!.id };
    } catch (e2) { return mapDbError(e2); }
  });
  clinicRoute(app, 'DELETE', '/api/availability/:id', { ...CAP, perm: 'schedule.manage' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query('DELETE FROM availability_rules WHERE id = $1', [id]);
    if (!r.rowCount) throw notFound('Horário não encontrado.');
    await audit(ctx, 'availability.delete', 'availability', id);
    return { ok: true };
  });

  // ------------------------------------------------------------ bloqueios
  clinicRoute(app, 'GET', '/api/blocks', { ...CAP, perm: 'agenda.read' }, async (ctx) => {
    const r = await ctx.tx.query(
      `SELECT b.id, b.starts_at AS "startsAt", b.ends_at AS "endsAt", b.reason, b.professional_id AS "professionalId", p.name AS "professionalName",
              b.resource_id AS "resourceId", r.name AS "resourceName"
         FROM schedule_blocks b
         LEFT JOIN users p ON p.tenant_id = b.tenant_id AND p.id = b.professional_id
         LEFT JOIN resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
        WHERE b.ends_at >= now() - interval '1 day' ORDER BY b.starts_at LIMIT 200`);
    return { blocks: r.rows };
  });
  clinicRoute(app, 'POST', '/api/blocks', { ...CAP, perm: 'schedule.manage' }, async (ctx) => {
    const b = z.object({
      startsAt: iso, endsAt: iso, reason: z.string().trim().min(2).max(200),
      professionalId: z.string().uuid().nullish().transform((v) => v ?? null),
      resourceId: z.string().uuid().nullish().transform((v) => v ?? null),
    }).parse(ctx.req.body);
    if (new Date(b.endsAt) <= new Date(b.startsAt)) throw badRequest('O término deve ser depois do início.');
    // Bloquear por cima de consultas marcadas exige remarcá-las antes (nada some em silêncio).
    const hit = await ctx.tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM appointments a
        WHERE a.status NOT IN ('cancelled','no_show','completed') AND tstzrange(a.starts_at, a.ends_at) && tstzrange($1::timestamptz, $2::timestamptz)
          AND (($3::uuid IS NULL AND $4::uuid IS NULL) OR a.professional_id = $3 OR (a.resource_id IS NOT NULL AND a.resource_id = $4))`,
      [b.startsAt, b.endsAt, b.professionalId, b.resourceId]);
    if (hit.rows[0]!.n > 0) throw conflict(`Há ${hit.rows[0]!.n} consulta(s) marcada(s) neste período. Remarque ou cancele antes de bloquear.`);
    try {
      const r = await ctx.tx.query<{ id: string }>(
        'INSERT INTO schedule_blocks (tenant_id, professional_id, resource_id, starts_at, ends_at, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [ctx.tenantId, b.professionalId, b.resourceId, b.startsAt, b.endsAt, b.reason, ctx.user.id]);
      await audit(ctx, 'block.create', 'block', r.rows[0]!.id);
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });
  clinicRoute(app, 'DELETE', '/api/blocks/:id', { ...CAP, perm: 'schedule.manage' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query('DELETE FROM schedule_blocks WHERE id = $1', [id]);
    if (!r.rowCount) throw notFound('Bloqueio não encontrado.');
    await audit(ctx, 'block.delete', 'block', id);
    return { ok: true };
  });

  // ------------------------------------------------------------ lista de espera
  clinicRoute(app, 'GET', '/api/waitlist', { ...CAP, perm: 'agenda.read' }, async (ctx) => {
    const r = await ctx.tx.query(
      `SELECT w.id, w.patient_id AS "patientId", p.name AS "patientName", w.professional_id AS "professionalId", u.name AS "professionalName",
              w.service, w.notes, w.priority, w.created_at AS "createdAt"
         FROM waitlist_entries w JOIN patients p ON p.tenant_id = w.tenant_id AND p.id = w.patient_id
         LEFT JOIN users u ON u.tenant_id = w.tenant_id AND u.id = w.professional_id
        WHERE w.status = 'waiting' ORDER BY (w.priority = 'priority') DESC, w.created_at LIMIT 200`);
    return { entries: r.rows };
  });
  clinicRoute(app, 'POST', '/api/waitlist', { ...CAP, perm: 'agenda.write' }, async (ctx) => {
    const b = z.object({
      patientId: z.string().uuid(),
      professionalId: z.string().uuid().nullish().transform((v) => v ?? null),
      service: z.string().trim().max(120).nullish().transform((v) => v || null),
      notes: z.string().trim().max(300).nullish().transform((v) => v || null),
      priority: z.enum(['normal', 'priority']).default('normal'),
    }).parse(ctx.req.body);
    await assertActive(ctx.tx, b.patientId);
    const dup = await ctx.tx.query(`SELECT 1 FROM waitlist_entries WHERE patient_id = $1 AND status = 'waiting' AND professional_id IS NOT DISTINCT FROM $2`, [b.patientId, b.professionalId]);
    if (dup.rowCount) throw conflict('Este paciente já está na lista de espera.');
    try {
      const r = await ctx.tx.query<{ id: string }>(
        'INSERT INTO waitlist_entries (tenant_id, patient_id, professional_id, service, notes, priority, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [ctx.tenantId, b.patientId, b.professionalId, b.service, b.notes, b.priority, ctx.user.id]);
      await audit(ctx, 'waitlist.add', 'waitlist', r.rows[0]!.id);
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });
  clinicRoute(app, 'PATCH', '/api/waitlist/:id', { ...CAP, perm: 'agenda.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ status: z.enum(['scheduled', 'cancelled']) }).parse(ctx.req.body);
    const r = await ctx.tx.query(`UPDATE waitlist_entries SET status = $1, resolved_at = now() WHERE id = $2 AND status = 'waiting'`, [b.status, id]);
    if (!r.rowCount) throw notFound('Entrada não encontrada ou já resolvida.');
    await audit(ctx, `waitlist.${b.status}`, 'waitlist', id);
    return { ok: true };
  });

  // ------------------------------------------------------------ recepção (hoje)
  clinicRoute(app, 'GET', '/api/reception', { ...CAP, perm: 'agenda.read' }, async (ctx) => {
    const r = await ctx.tx.query(
      `SELECT ${APPT_SELECT} ${APPT_FROM}
        WHERE a.status IN ('scheduled','confirmed','checked_in','called','in_service')
          AND a.starts_at >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
          AND a.starts_at <  (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') + interval '1 day'
        ORDER BY a.starts_at LIMIT 300`);
    return { appointments: r.rows, now: new Date().toISOString() };
  });
}
