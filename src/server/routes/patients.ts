import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute } from '../context.js';
import { HttpError, notFound } from '../http.js';
import { findDuplicates } from '../../modules/patients/family.js';
import { hasPermission } from '../auth/rbac.js';

const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const patientBody = z.object({
  name: z.string().trim().min(2, 'Informe o nome.').max(160),
  socialName: opt(160),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.').nullish().transform((v) => v ?? null),
  phone: opt(30),
  email: z.string().trim().toLowerCase().email('E-mail inválido.').max(200).nullish().or(z.literal('')).transform((v) => v || null),
  document: opt(30),
  alert: opt(500),
});

const COLUMNS: Record<string, string> = {
  name: 'name', socialName: 'social_name', birthDate: 'birth_date', phone: 'phone', email: 'email', document: 'document', alert: 'alert',
};
const SELECT = `id, name, social_name AS "socialName", to_char(birth_date,'YYYY-MM-DD') AS "birthDate", phone, email, document, alert, created_at AS "createdAt", merged_into AS "mergedInto"`;

export function patientRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/patients', { cap: 'patient.registry', perm: 'patients.read' }, async (ctx) => {
    const { q } = z.object({ q: z.string().trim().max(80).optional() }).parse(ctx.req.query);
    const like = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const r = await ctx.tx.query(
      `SELECT ${SELECT} FROM patients
        WHERE merged_into IS NULL AND ($1::text IS NULL OR name ILIKE $1 OR social_name ILIKE $1 OR phone ILIKE $1 OR document ILIKE $1)
        ORDER BY lower(name) LIMIT 100`, [like]);
    const canSeeAlert = hasPermission(ctx.user.role, 'notes.read');
    return { patients: r.rows.map((p) => (canSeeAlert ? p : { ...p, alert: null })) };
  });

  clinicRoute(app, 'POST', '/api/patients', { cap: 'patient.registry', perm: 'patients.write' }, async (ctx) => {
    const body = z.object({ confirmNotDuplicate: z.boolean().optional() }).passthrough().parse(ctx.req.body);
    const b = patientBody.parse(ctx.req.body);
    if (!body.confirmNotDuplicate) {
      const candidates = await findDuplicates(ctx.tx, b);
      if (candidates.length) throw new HttpError(409, 'Já existe um cadastro parecido. Confira antes de criar outro.', 'possible_duplicate', { candidates });
    }
    const r = await ctx.tx.query<{ id: string }>(
      `INSERT INTO patients (tenant_id, name, social_name, birth_date, phone, email, document, alert, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ctx.tenantId, b.name, b.socialName, b.birthDate, b.phone, b.email, b.document, hasPermission(ctx.user.role, 'notes.read') ? b.alert : null, ctx.user.id]);
    await audit(ctx, 'patient.create', 'patient', r.rows[0]!.id);
    return { id: r.rows[0]!.id };
  });

  clinicRoute(app, 'GET', '/api/patients/:id', { cap: 'patient.registry', perm: 'patients.read' }, async (ctx) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(ctx.req.params);
    const r = await ctx.tx.query(`SELECT ${SELECT} FROM patients WHERE id = $1`, [id]);
    if (!r.rows[0]) throw notFound('Paciente não encontrado.');
    await audit(ctx, 'patient.read', 'patient', id);
    const p = r.rows[0];
    return { patient: hasPermission(ctx.user.role, 'notes.read') ? p : { ...p, alert: null } };
  });

  clinicRoute(app, 'PATCH', '/api/patients/:id', { cap: 'patient.registry', perm: 'patients.write' }, async (ctx) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(ctx.req.params);
    const parsed = patientBody.partial().parse(ctx.req.body) as Record<string, unknown>;
    if (!hasPermission(ctx.user.role, 'notes.read')) delete parsed.alert; // alerta clínico: só quem pode ver
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, col] of Object.entries(COLUMNS)) { // allowlist de colunas
      if (key in parsed) { values.push(parsed[key]); sets.push(`${col} = $${values.length}`); }
    }
    if (!sets.length) return { ok: true };
    values.push(id);
    const r = await ctx.tx.query(`UPDATE patients SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`, values);
    if (!r.rowCount) throw notFound('Paciente não encontrado.');
    await audit(ctx, 'patient.update', 'patient', id, { fields: Object.keys(parsed) });
    return { ok: true };
  });
}
