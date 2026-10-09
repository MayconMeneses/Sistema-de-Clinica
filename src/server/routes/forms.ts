import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertActive, family } from '../../modules/patients/family.js';
import { DEFAULT_TEMPLATES, fieldsSchema, validateAnswers, type FormField } from '../../modules/forms/schema.js';
import { hasPermission } from '../auth/rbac.js';
import { audit, clinicRoute } from '../context.js';
import { assertApptVisible } from '../scope.js';
import { badRequest, conflict, mapDbError, notFound } from '../http.js';

const CAP = { cap: 'clinical.forms' } as const;
const idParam = z.object({ id: z.string().uuid() });
const canReadAnswers = (role: string) => hasPermission(role, 'triage.read');
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const triageBody = z.object({
  appointmentId: z.string().uuid().optional(),
  weightKg: num(1, 500).optional(), heightCm: num(20, 260).optional(),
  bpSystolic: z.number().int().min(40).max(300).optional(), bpDiastolic: z.number().int().min(20).max(200).optional(),
  heartRate: z.number().int().min(20).max(300).optional(), temperatureC: num(30, 45).optional(),
  painScale: z.number().int().min(0).max(10).optional(),
  allergies: z.string().trim().max(300).optional(), medications: z.string().trim().max(300).optional(),
  complaint: z.string().trim().max(300).optional(), notes: z.string().trim().max(500).optional(),
}).strict();

export function formRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ modelos
  clinicRoute(app, 'GET', '/api/form-templates', { ...CAP, perm: 'forms.assign' }, async (ctx) => {
    const q = z.object({ all: z.enum(['1']).optional() }).parse(ctx.req.query);
    const r = await ctx.tx.query(
      `SELECT DISTINCT ON (key) id, key, version, name, fields, active, created_at AS "createdAt" FROM form_templates
        ORDER BY key, version DESC`);
    const rows = q.all === '1' ? r.rows : r.rows.filter((x) => x.active);
    return { templates: rows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')) };
  });

  const createTemplate = async (ctx: Parameters<Parameters<typeof clinicRoute>[4]>[0], name: string, key: string, fields: FormField[]) => {
    const v = await ctx.tx.query<{ v: number }>('SELECT COALESCE(max(version), 0) + 1 AS v FROM form_templates WHERE key = $1', [key]);
    const r = await ctx.tx.query<{ id: string }>(
      'INSERT INTO form_templates (tenant_id, key, version, name, fields, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [ctx.tenantId, key, v.rows[0]!.v, name, JSON.stringify(fields), ctx.user.id]);
    return { id: r.rows[0]!.id, version: v.rows[0]!.v };
  };

  clinicRoute(app, 'POST', '/api/form-templates', { ...CAP, perm: 'forms.manage' }, async (ctx) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), key: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/).optional(), fields: fieldsSchema }).parse(ctx.req.body);
    const key = b.key ?? slug(b.name);
    if (key.length < 2) throw badRequest('Dê um nome ao formulário.');
    try {
      const t = await createTemplate(ctx, b.name, key, b.fields);
      await audit(ctx, 'form.template_saved', 'form_template', t.id, { key, version: t.version });
      return { ...t, key };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'POST', '/api/form-templates/defaults', { ...CAP, perm: 'forms.manage' }, async (ctx) => {
    const have = new Set((await ctx.tx.query<{ key: string }>('SELECT DISTINCT key FROM form_templates')).rows.map((r) => r.key));
    const installed: string[] = [];
    for (const t of DEFAULT_TEMPLATES) {
      if (have.has(t.key)) continue;
      await createTemplate(ctx, t.name, t.key, t.fields);
      installed.push(t.name);
    }
    if (installed.length) await audit(ctx, 'form.defaults_installed', 'form_template', undefined, { count: installed.length });
    return { installed };
  });

  clinicRoute(app, 'POST', '/api/form-templates/:id/active', { ...CAP, perm: 'forms.manage' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ active: z.boolean() }).parse(ctx.req.body);
    const r = await ctx.tx.query('UPDATE form_templates SET active = $2 WHERE id = $1', [id, b.active]);
    if (!r.rowCount) throw notFound('Modelo não encontrado.');
    await audit(ctx, b.active ? 'form.template_activated' : 'form.template_deactivated', 'form_template', id);
    return { ok: true };
  });

  // ------------------------------------------------------------ pedidos de formulário (por paciente)
  clinicRoute(app, 'POST', '/api/patients/:id/forms', { ...CAP, perm: 'forms.assign' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ templateId: z.string().uuid(), appointmentId: z.string().uuid().optional() }).parse(ctx.req.body);
    if (!(await ctx.tx.query('SELECT 1 FROM patients WHERE id = $1', [id])).rowCount) throw notFound('Paciente não encontrado.');
    await assertActive(ctx.tx, id);
    const t = await ctx.tx.query<{ active: boolean }>('SELECT active FROM form_templates WHERE id = $1', [b.templateId]);
    if (!t.rows[0]) throw notFound('Modelo não encontrado.');
    if (!t.rows[0].active) throw conflict('Este modelo está desativado.');
    if (b.appointmentId) {
      await assertApptVisible(ctx, b.appointmentId);
      const ids = await family(ctx.tx, id);
      if (!(await ctx.tx.query('SELECT 1 FROM appointments WHERE id = $1 AND patient_id = ANY($2::uuid[])', [b.appointmentId, ids])).rowCount) throw badRequest('Essa consulta não é deste paciente.');
    }
    try {
      const r = await ctx.tx.query<{ id: string }>(
        'INSERT INTO form_requests (tenant_id, patient_id, appointment_id, template_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [ctx.tenantId, id, b.appointmentId ?? null, b.templateId, ctx.user.id]);
      await audit(ctx, 'form.requested', 'form_request', r.rows[0]!.id, { patientId: id });
      return { id: r.rows[0]!.id };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('Este formulário já foi pedido a este paciente e está aguardando resposta.');
      return mapDbError(e);
    }
  });

  clinicRoute(app, 'GET', '/api/patients/:id/forms', { ...CAP, perm: 'forms.assign' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const clinical = canReadAnswers(ctx.user.role);
    const r = await ctx.tx.query(
      `SELECT f.id, f.status, f.created_at AS "createdAt", f.submitted_at AS "submittedAt", f.submitted_via AS "submittedVia", f.appointment_id AS "appointmentId",
              t.name AS "templateName", t.version AS "templateVersion", t.fields,
              ${clinical ? 'f.answers' : 'NULL::jsonb'} AS answers
         FROM form_requests f JOIN form_templates t ON t.tenant_id = f.tenant_id AND t.id = f.template_id
        WHERE f.patient_id = ANY($1::uuid[]) ORDER BY f.created_at DESC LIMIT 100`, [await family(ctx.tx, id)]);
    if (clinical && r.rows.some((x) => x.status === 'submitted')) await audit(ctx, 'record.read', 'patient', id, { forms: r.rowCount });
    return { forms: r.rows.map((x) => (clinical ? x : { ...x, fields: undefined })), canReadAnswers: clinical };
  });

  clinicRoute(app, 'GET', '/api/forms/:id', { ...CAP, perm: 'forms.assign' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query(
      `SELECT f.id, f.status, f.patient_id AS "patientId", t.name, t.fields FROM form_requests f JOIN form_templates t ON t.tenant_id = f.tenant_id AND t.id = f.template_id WHERE f.id = $1`, [id]);
    if (!r.rows[0]) throw notFound('Formulário não encontrado.');
    // quem preenche na recepção vê as perguntas, mas não lê respostas já enviadas (só quem acessa o prontuário)
    return r.rows[0].status === 'pending' || canReadAnswers(ctx.user.role) ? r.rows[0] : { ...r.rows[0], fields: [] };
  });

  clinicRoute(app, 'POST', '/api/forms/:id/submit', { ...CAP, perm: 'forms.assign' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ answers: z.record(z.string(), z.unknown()) }).parse(ctx.req.body);
    const r = await ctx.tx.query<{ status: string; fields: FormField[]; patient_id: string }>(
      `SELECT f.status, t.fields, f.patient_id FROM form_requests f JOIN form_templates t ON t.tenant_id = f.tenant_id AND t.id = f.template_id WHERE f.id = $1 FOR UPDATE OF f`, [id]);
    const f = r.rows[0];
    if (!f) throw notFound('Formulário não encontrado.');
    if (f.status !== 'pending') throw conflict('Este formulário já foi respondido ou cancelado.');
    const answers = validateAnswers(f.fields, b.answers);
    await ctx.tx.query(`UPDATE form_requests SET status = 'submitted', answers = $2, submitted_at = now(), submitted_via = 'staff', submitted_by = $3 WHERE id = $1`, [id, JSON.stringify(answers), ctx.user.id]);
    await audit(ctx, 'form.submitted', 'form_request', id, { patientId: f.patient_id, via: 'staff' });
    return { ok: true };
  });

  clinicRoute(app, 'POST', '/api/forms/:id/cancel', { ...CAP, perm: 'forms.assign' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query<{ status: string }>('SELECT status FROM form_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!r.rows[0]) throw notFound('Formulário não encontrado.');
    if (r.rows[0].status !== 'pending') throw conflict('Só formulário aguardando resposta pode ser cancelado.');
    await ctx.tx.query(`UPDATE form_requests SET status = 'canceled', canceled_at = now() WHERE id = $1`, [id]);
    await audit(ctx, 'form.canceled', 'form_request', id);
    return { ok: true };
  });

  // ------------------------------------------------------------ triagem
  clinicRoute(app, 'POST', '/api/patients/:id/triage', { ...CAP, perm: 'triage.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = triageBody.parse(ctx.req.body);
    if ((b.bpSystolic === undefined) !== (b.bpDiastolic === undefined)) throw badRequest('Informe a pressão sistólica e a diastólica juntas.');
    if (b.bpSystolic !== undefined && b.bpDiastolic !== undefined && b.bpSystolic <= b.bpDiastolic) throw badRequest('A pressão sistólica precisa ser maior que a diastólica.');
    const text = (v?: string) => (v ? v : undefined);
    if ([b.weightKg, b.heightCm, b.bpSystolic, b.heartRate, b.temperatureC, b.painScale, text(b.allergies), text(b.medications), text(b.complaint), text(b.notes)].every((x) => x === undefined)) throw badRequest('Preencha ao menos um dado da triagem.');
    if (!(await ctx.tx.query('SELECT 1 FROM patients WHERE id = $1', [id])).rowCount) throw notFound('Paciente não encontrado.');
    await assertActive(ctx.tx, id);
    if (b.appointmentId) {
      await assertApptVisible(ctx, b.appointmentId);
      if (!(await ctx.tx.query('SELECT 1 FROM appointments WHERE id = $1 AND patient_id = ANY($2::uuid[])', [b.appointmentId, await family(ctx.tx, id)])).rowCount) throw badRequest('Essa consulta não é deste paciente.');
    }
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO triage_records (tenant_id, patient_id, appointment_id, recorded_by, weight_kg, height_cm, bp_systolic, bp_diastolic, heart_rate, temperature_c, pain_scale, allergies, medications, complaint, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [ctx.tenantId, id, b.appointmentId ?? null, ctx.user.id, b.weightKg ?? null, b.heightCm ?? null, b.bpSystolic ?? null, b.bpDiastolic ?? null, b.heartRate ?? null, b.temperatureC ?? null, b.painScale ?? null,
          text(b.allergies) ?? null, text(b.medications) ?? null, text(b.complaint) ?? null, text(b.notes) ?? null]);
      await audit(ctx, 'triage.created', 'triage_record', r.rows[0]!.id, { patientId: id });
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'GET', '/api/patients/:id/triage', { ...CAP, perm: 'triage.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query(
      `SELECT t.id, t.recorded_at AS "recordedAt", t.appointment_id AS "appointmentId", t.weight_kg::float8 AS "weightKg", t.height_cm::float8 AS "heightCm", t.bp_systolic AS "bpSystolic", t.bp_diastolic AS "bpDiastolic",
              t.heart_rate AS "heartRate", t.temperature_c::float8 AS "temperatureC", t.pain_scale AS "painScale", t.allergies, t.medications, t.complaint, t.notes, u.name AS "recordedByName"
         FROM triage_records t LEFT JOIN users u ON u.tenant_id = t.tenant_id AND u.id = t.recorded_by
        WHERE t.patient_id = ANY($1::uuid[]) ORDER BY t.recorded_at DESC LIMIT 30`, [await family(ctx.tx, id)]);
    await audit(ctx, 'record.read', 'patient', id, { triage: r.rowCount });
    return { triage: r.rows };
  });
}
