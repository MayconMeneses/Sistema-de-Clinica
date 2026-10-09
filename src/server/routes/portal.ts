import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../db/tenant.js';
import { family } from '../../modules/patients/family.js';
import { hasPermission } from '../auth/rbac.js';
import { DbRateLimiter } from '../auth/rate-limit.js';
import { config } from '../config.js';
import { audit, auditPortal, clinicRoute, cookieOptions, PORTAL_COOKIE, portalRoute } from '../context.js';
import { appPool } from '../db.js';
import { CLINICAL_CATEGORIES } from './documents.js';
import { validateAnswers, type FormField } from '../../modules/forms/schema.js';
import { apptInScope, assertApptVisible, PATIENT_VISIBLE_SQL, unitScope } from '../scope.js';
import { badRequest, conflict, forbidden, HttpError, isRealDate, mapDbError, newSecret, notFound, sha256, unauthorized } from '../http.js';

const CAP = { cap: 'patient.portal' } as const;
const idParam = z.object({ id: z.string().uuid() });
const INVITE_HOURS = 48;
const SESSION_HOURS = 8;
const MAX_INVITE_ATTEMPTS = 5;
const CANCEL_MIN_HOURS = 24;
const GENERIC_LOGIN_ERROR = 'Link inválido ou expirado, ou os dados não conferem. Peça um novo link à clínica.';

const ipLimiter = { tooMany: (k: string) => new DbRateLimiter(appPool, Number(process.env.LOGIN_IP_MAX ?? 30), 15).tooMany(k) };
const limiter = new DbRateLimiter(appPool, 10, 15);

export function portalRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ EQUIPE: convite, acesso e pedidos
  clinicRoute(app, 'POST', '/api/patients/:id/portal-invite', { ...CAP, perm: 'portal.manage' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const p = await ctx.tx.query<{ name: string; birth_date: string | null; merged_into: string | null }>('SELECT name, birth_date::text, merged_into FROM patients WHERE id = $1', [id]);
    const patient = p.rows[0];
    if (!patient) throw notFound('Paciente não encontrado.');
    if (patient.merged_into) throw conflict('Este cadastro foi mesclado a outro. Use o cadastro principal.');
    if (!patient.birth_date) throw badRequest('Cadastre a data de nascimento do paciente: ela confirma a identidade no primeiro acesso.');
    await ctx.tx.query('UPDATE portal_invites SET revoked_at = now() WHERE patient_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [id]);
    const token = newSecret();
    const r = await ctx.tx.query<{ id: string; expires_at: Date }>(
      `INSERT INTO portal_invites (tenant_id, patient_id, token_hash, created_by, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5)) RETURNING id, expires_at`,
      [ctx.tenantId, id, sha256(token), ctx.user.id, INVITE_HOURS]);
    const slug = (await ctx.tx.query<{ slug: string }>('SELECT slug FROM tenants')).rows[0]!.slug;
    await audit(ctx, 'portal.invite_created', 'patient', id);
    return { link: `${config.publicUrl}/#/portal?clinic=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`, expiresAt: r.rows[0]!.expires_at, hours: INVITE_HOURS };
  });

  clinicRoute(app, 'GET', '/api/patients/:id/portal-status', { ...CAP, perm: 'portal.manage' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    if (!(await ctx.tx.query('SELECT 1 FROM patients WHERE id = $1', [id])).rowCount) throw notFound('Paciente não encontrado.');
    const r = await ctx.tx.query(
      `SELECT (SELECT birth_date IS NOT NULL FROM patients WHERE id = $1) AS "hasBirthDate",
              EXISTS (SELECT 1 FROM portal_sessions WHERE patient_id = $1 AND revoked_at IS NULL AND expires_at > now()) AS "hasActiveSession",
              EXISTS (SELECT 1 FROM portal_invites WHERE patient_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() AND attempts < $2) AS "hasOpenInvite",
              (SELECT max(created_at) FROM portal_sessions WHERE patient_id = $1) AS "lastAccessAt"`, [id, MAX_INVITE_ATTEMPTS]);
    return r.rows[0];
  });

  clinicRoute(app, 'POST', '/api/patients/:id/portal-revoke', { ...CAP, perm: 'portal.manage' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    if (!(await ctx.tx.query('SELECT 1 FROM patients WHERE id = $1', [id])).rowCount) throw notFound('Paciente não encontrado.');
    const a = await ctx.tx.query('UPDATE portal_invites SET revoked_at = now() WHERE patient_id = $1 AND revoked_at IS NULL AND used_at IS NULL', [id]);
    const b = await ctx.tx.query('UPDATE portal_sessions SET revoked_at = now() WHERE patient_id = $1 AND revoked_at IS NULL', [id]);
    await audit(ctx, 'portal.access_revoked', 'patient', id, { invites: a.rowCount, sessions: b.rowCount });
    return { ok: true, invites: a.rowCount ?? 0, sessions: b.rowCount ?? 0 };
  });

  clinicRoute(app, 'POST', '/api/documents/:id/share', { ...CAP, perm: 'documents.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ shared: z.boolean() }).parse(ctx.req.body);
    const d = await ctx.tx.query<{ category: string; archived_at: Date | null }>('SELECT category, archived_at FROM patient_documents WHERE id = $1', [id]);
    const doc = d.rows[0];
    if (!doc || (CLINICAL_CATEGORIES.includes(doc.category) && !hasPermission(ctx.user.role, 'notes.read'))) throw notFound('Documento não encontrado.');
    if (doc.archived_at) throw conflict('Documento arquivado não pode ser compartilhado.');
    await ctx.tx.query('UPDATE patient_documents SET shared_with_patient = $2 WHERE id = $1', [id, b.shared]);
    await audit(ctx, b.shared ? 'document.shared' : 'document.unshared', 'patient_document', id);
    return { ok: true, shared: b.shared };
  });

  clinicRoute(app, 'GET', '/api/portal-requests', { ...CAP, perm: 'portal.manage' }, async (ctx) => {
    const q = z.object({ status: z.enum(['open', 'done', 'dismissed']).default('open') }).parse(ctx.req.query);
    const r = await ctx.tx.query(
      `SELECT r.id, r.kind, r.message, r.status, r.created_at AS "createdAt", r.patient_id AS "patientId", p.name AS "patientName",
              r.appointment_id AS "appointmentId", a.starts_at AS "startsAt", a.service, a.status AS "appointmentStatus", u.name AS "professionalName"
         FROM portal_requests r JOIN patients p ON p.tenant_id = r.tenant_id AND p.id = r.patient_id
         LEFT JOIN appointments a ON a.tenant_id = r.tenant_id AND a.id = r.appointment_id
         LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.professional_id
        WHERE r.status = $1 AND (r.appointment_id IS NULL OR ${apptInScope(2)}) AND ${PATIENT_VISIBLE_SQL('r.patient_id', 2, 3)}
        ORDER BY r.created_at DESC LIMIT 100`, [q.status, await unitScope(ctx), ctx.user.id]);
    return { requests: r.rows };
  });

  clinicRoute(app, 'POST', '/api/portal-requests/:id/resolve', { ...CAP, perm: 'portal.manage' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ action: z.enum(['done', 'dismissed']), note: z.string().trim().max(300).optional() }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ kind: string; status: string; appointment_id: string | null }>('SELECT kind, status, appointment_id FROM portal_requests WHERE id = $1 FOR UPDATE', [id]);
    const req = cur.rows[0];
    if (!req) throw notFound('Pedido não encontrado.');
    if (req.status !== 'open') throw conflict('Este pedido já foi tratado.');
    if (req.appointment_id) await assertApptVisible(ctx, req.appointment_id);
    if (b.action === 'done' && req.kind === 'cancel' && req.appointment_id) {
      await ctx.tx.query(
        `UPDATE appointments SET status = 'cancelled', cancel_reason = 'Cancelado a pedido do paciente (portal)' WHERE id = $1 AND status IN ('scheduled','confirmed')`, [req.appointment_id]);
    }
    await ctx.tx.query(`UPDATE portal_requests SET status = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4 WHERE id = $1`, [id, b.action, ctx.user.id, b.note ?? null]);
    await audit(ctx, `portal.request.${b.action}`, 'portal_request', id, { kind: req.kind });
    return { ok: true };
  });

  // ------------------------------------------------------------ PACIENTE: entrada
  app.post('/api/portal/login', async (req, reply) => {
    const b = z.object({
      clinic: z.string().trim().toLowerCase().min(2).max(63),
      token: z.string().trim().min(20).max(200),
      birthDate: z.string().refine(isRealDate, 'Data de nascimento inválida.'),
    }).parse(req.body);
    const key = `portal|${req.ip}|${b.clinic}`;
    if (await limiter.tooMany(key) || await ipLimiter.tooMany(`ip|portal|${req.ip}`)) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'rate_limited');
    const fail = async () => { await limiter.record(key); await limiter.record(`ip|portal|${req.ip}`); throw unauthorized(GENERIC_LOGIN_ERROR); };
    const dir = await appPool.query<{ tenant_id: string; status: string }>('SELECT tenant_id, status FROM tenant_directory WHERE slug = $1', [b.clinic]);
    const entry = dir.rows[0];
    if (!entry || entry.status !== 'active') return fail();

    const outcome = await withTenant(appPool, entry.tenant_id, async (tx) => {
      const ent = await tx.query<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM plan_capabilities pc JOIN tenants t ON t.plan_code = pc.plan_code WHERE pc.capability_code = 'patient.portal') AS ok`);
      if (!ent.rows[0]?.ok) return { kind: 'fail' as const };
      const r = await tx.query<{ id: string; patient_id: string; attempts: number; birth_date: string | null }>(
        `SELECT i.id, i.patient_id, i.attempts, p.birth_date::text
           FROM portal_invites i JOIN patients p ON p.tenant_id = i.tenant_id AND p.id = i.patient_id
          WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND p.merged_into IS NULL FOR UPDATE OF i`, [sha256(b.token)]);
      const inv = r.rows[0];
      if (!inv || inv.attempts >= MAX_INVITE_ATTEMPTS) return { kind: 'fail' as const };
      if (!inv.birth_date || inv.birth_date !== b.birthDate) {
        await tx.query('UPDATE portal_invites SET attempts = attempts + 1 WHERE id = $1', [inv.id]);   // grava mesmo no erro: o convite trava depois de 5
        return { kind: 'fail' as const };
      }
      await tx.query('UPDATE portal_invites SET used_at = now() WHERE id = $1', [inv.id]);
      const secret = newSecret();
      await tx.query(
        `INSERT INTO portal_sessions (id, tenant_id, patient_id, token_hash, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5))`,
        [randomUUID(), entry.tenant_id, inv.patient_id, sha256(secret), SESSION_HOURS]);
      await tx.query(
        `INSERT INTO audit_events (tenant_id, actor_id, action, entity_type, entity_id, metadata) VALUES ($1, NULL, 'portal.login', 'patient', $2, $3)`,
        [entry.tenant_id, inv.patient_id, JSON.stringify({ via: 'portal', ip: req.ip })]);
      return { kind: 'ok' as const, cookie: `${entry.tenant_id}.${secret}` };
    });
    if (outcome.kind === 'fail') return fail();
    reply.setCookie(PORTAL_COOKIE, outcome.cookie, cookieOptions('/api/portal', SESSION_HOURS));
    return { ok: true };
  });

  portalRoute(app, 'POST', '/api/portal/logout', {}, async (ctx, _req, reply) => {
    await ctx.tx.query('UPDATE portal_sessions SET revoked_at = now() WHERE id = $1', [ctx.sessionId]);
    reply.clearCookie(PORTAL_COOKIE, cookieOptions('/api/portal', 0));
    return { ok: true };
  });

  // ------------------------------------------------------------ PACIENTE: o que é dele
  portalRoute(app, 'GET', '/api/portal/me', {}, async (ctx) => {
    const ids = await family(ctx.tx, ctx.patient.id);
    const appt = await ctx.tx.query(
      `SELECT a.id, a.starts_at AS "startsAt", a.ends_at AS "endsAt", a.status, a.service, u.name AS "professionalName",
              (a.starts_at > now() AND a.status IN ('scheduled','confirmed')) AS "isUpcoming",
              (a.starts_at > now() + make_interval(hours => $2) AND a.status IN ('scheduled','confirmed')) AS "canCancelNow",
              (a.status = 'scheduled' AND a.starts_at > now()) AS "canConfirm",
              EXISTS (SELECT 1 FROM portal_requests r WHERE r.appointment_id = a.id AND r.status = 'open') AS "hasOpenRequest"
         FROM appointments a JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.professional_id
        WHERE a.patient_id = ANY($1::uuid[]) AND a.starts_at > now() - interval '60 days'
        ORDER BY a.starts_at DESC LIMIT 40`, [ids, CANCEL_MIN_HOURS]);
    const docs = await ctx.tx.query(
      `SELECT id, title, category, file_name AS "fileName", size_bytes AS "sizeBytes", created_at AS "createdAt"
         FROM patient_documents WHERE patient_id = ANY($1::uuid[]) AND shared_with_patient AND archived_at IS NULL ORDER BY created_at DESC LIMIT 50`, [ids]);
    const reqs = await ctx.tx.query(
      `SELECT id, kind, message, status, created_at AS "createdAt" FROM portal_requests WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at DESC LIMIT 10`, [ids]);
    const upcoming = appt.rows.filter((a) => a.isUpcoming).reverse();
    const past = appt.rows.filter((a) => !a.isUpcoming).slice(0, 8);
    // Formulários pendentes: só título e data da consulta. As perguntas vêm em /forms/:id; respostas nunca voltam ao portal.
    const forms = ctx.entitlements.has('clinical.forms')
      ? (await ctx.tx.query(
        `SELECT f.id, t.name, f.created_at AS "createdAt", a.starts_at AS "appointmentAt"
           FROM form_requests f JOIN form_templates t ON t.tenant_id = f.tenant_id AND t.id = f.template_id
           LEFT JOIN appointments a ON a.tenant_id = f.tenant_id AND a.id = f.appointment_id
          WHERE f.patient_id = ANY($1::uuid[]) AND f.status = 'pending' ORDER BY f.created_at DESC LIMIT 20`, [ids])).rows
      : [];
    return { clinic: ctx.tenantName, patient: { name: ctx.patient.name }, cancelMinHours: CANCEL_MIN_HOURS, upcoming, past, documents: docs.rows, requests: reqs.rows, pendingForms: forms };
  });

  const ownAppt = async (ctx: Parameters<Parameters<typeof portalRoute>[4]>[0], id: string) => {
    const ids = await family(ctx.tx, ctx.patient.id);
    const r = await ctx.tx.query<{ id: string; status: string; starts_at: Date }>('SELECT id, status, starts_at FROM appointments WHERE id = $1 AND patient_id = ANY($2::uuid[]) FOR UPDATE', [id, ids]);
    if (!r.rows[0]) throw notFound('Consulta não encontrada.');
    return r.rows[0];
  };

  portalRoute(app, 'POST', '/api/portal/appointments/:id/confirm', {}, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const a = await ownAppt(ctx, id);
    if (a.starts_at.getTime() <= Date.now()) throw conflict('Esta consulta já passou.');
    if (a.status === 'confirmed') return { ok: true, status: 'confirmed' };
    if (a.status !== 'scheduled') throw conflict('Esta consulta não pode ser confirmada.');
    await ctx.tx.query(`UPDATE appointments SET status = 'confirmed' WHERE id = $1`, [id]);
    await auditPortal(ctx, 'portal.appointment_confirmed', 'appointment', id);
    return { ok: true, status: 'confirmed' };
  });

  portalRoute(app, 'POST', '/api/portal/appointments/:id/cancel', {}, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ reason: z.string().trim().max(200).optional() }).parse(ctx.req.body);
    const a = await ownAppt(ctx, id);
    if (a.starts_at.getTime() <= Date.now() || !['scheduled', 'confirmed'].includes(a.status)) throw conflict('Esta consulta não pode mais ser cancelada pelo portal.');
    if (a.starts_at.getTime() - Date.now() >= CANCEL_MIN_HOURS * 3_600_000) {
      await ctx.tx.query(`UPDATE appointments SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, `Cancelado pelo paciente (portal)${b.reason ? `: ${b.reason}` : ''}`.slice(0, 250)]);
      await auditPortal(ctx, 'portal.appointment_cancelled', 'appointment', id);
      return { ok: true, status: 'cancelled' };
    }
    // Em cima da hora: a recepção decide (pode haver regra de cobrança ou chance de reencaixe).
    try {
      await ctx.tx.query(`INSERT INTO portal_requests (tenant_id, patient_id, kind, appointment_id, message) VALUES ($1,$2,'cancel',$3,$4)`, [ctx.tenantId, ctx.patient.id, id, b.reason || null]);
    } catch (e) { if ((e as { code?: string }).code === '23505') throw conflict('Você já pediu o cancelamento desta consulta. A clínica vai responder.'); return mapDbError(e); }
    await auditPortal(ctx, 'portal.cancel_requested', 'appointment', id);
    return { ok: true, status: 'requested', message: `Faltam menos de ${CANCEL_MIN_HOURS} horas: enviamos o pedido de cancelamento para a clínica.` };
  });

  portalRoute(app, 'POST', '/api/portal/requests', {}, async (ctx) => {
    const b = z.object({
      kind: z.enum(['schedule', 'reschedule']),
      appointmentId: z.string().uuid().optional(),
      message: z.string().trim().min(3, 'Conte o dia e o horário que você prefere.').max(300),
    }).parse(ctx.req.body);
    if (b.kind === 'reschedule' && !b.appointmentId) throw badRequest('Escolha a consulta que quer remarcar.');
    if (b.kind === 'schedule') {
      const n = await ctx.tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM portal_requests WHERE patient_id = $1 AND kind = 'schedule' AND status = 'open'`, [ctx.patient.id]);
      if ((n.rows[0]?.n ?? 0) >= 3) throw conflict('Você já tem pedidos em andamento. Aguarde o retorno da clínica.');
    }
    if (b.appointmentId) {
      const a = await ownAppt(ctx, b.appointmentId);
      if (a.starts_at.getTime() <= Date.now() || !['scheduled', 'confirmed'].includes(a.status)) throw conflict('Esta consulta não pode ser remarcada pelo portal.');
    }
    let id: string;
    try {
      id = (await ctx.tx.query<{ id: string }>(
        `INSERT INTO portal_requests (tenant_id, patient_id, kind, appointment_id, message) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [ctx.tenantId, ctx.patient.id, b.kind, b.appointmentId ?? null, b.message])).rows[0]!.id;
    } catch (e) { if ((e as { code?: string }).code === '23505') throw conflict('Você já tem um pedido aberto para esta consulta.'); return mapDbError(e); }
    await auditPortal(ctx, `portal.${b.kind}_requested`, 'portal_request', id);
    return { ok: true, id };
  });

  portalRoute(app, 'GET', '/api/portal/documents/:id/download', {}, async (ctx, _req, reply) => {
    const { id } = idParam.parse(ctx.req.params);
    const ids = await family(ctx.tx, ctx.patient.id);
    const r = await ctx.tx.query<{ file_name: string; mime_type: string; content: Buffer }>(
      'SELECT file_name, mime_type, content FROM patient_documents WHERE id = $1 AND patient_id = ANY($2::uuid[]) AND shared_with_patient AND archived_at IS NULL', [id, ids]);
    const d = r.rows[0];
    if (!d) throw notFound('Documento não encontrado.');
    await auditPortal(ctx, 'portal.document_read', 'patient_document', id);
    const name = d.file_name.replace(/[\r\n"\\/]/g, '_');
    reply.header('content-type', d.mime_type).header('content-disposition', `attachment; filename="${name}"`).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store');
    return reply.send(d.content);
  });

  const ownPendingForm = async (ctx: Parameters<Parameters<typeof portalRoute>[4]>[0], id: string, lock: boolean) => {
    if (!ctx.entitlements.has('clinical.forms')) throw notFound('Formulário não encontrado.');
    const ids = await family(ctx.tx, ctx.patient.id);
    const r = await ctx.tx.query<{ id: string; name: string; fields: FormField[] }>(
      `SELECT f.id, t.name, t.fields FROM form_requests f JOIN form_templates t ON t.tenant_id = f.tenant_id AND t.id = f.template_id
        WHERE f.id = $1 AND f.patient_id = ANY($2::uuid[]) AND f.status = 'pending' ${lock ? 'FOR UPDATE OF f' : ''}`, [id, ids]);
    if (!r.rows[0]) throw notFound('Formulário não encontrado ou já respondido.');
    return r.rows[0];
  };

  portalRoute(app, 'GET', '/api/portal/forms/:id', {}, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    return await ownPendingForm(ctx, id, false);
  });

  portalRoute(app, 'POST', '/api/portal/forms/:id/submit', {}, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ answers: z.record(z.string(), z.unknown()) }).parse(ctx.req.body);
    const f = await ownPendingForm(ctx, id, true);
    const answers = validateAnswers(f.fields, b.answers);
    await ctx.tx.query(`UPDATE form_requests SET status = 'submitted', answers = $2, submitted_at = now(), submitted_via = 'portal' WHERE id = $1`, [id, JSON.stringify(answers)]);
    await auditPortal(ctx, 'portal.form_submitted', 'form_request', id);
    return { ok: true };
  });
}
