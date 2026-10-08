import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute, type ClinicCtx } from '../context.js';
import { hasPermission } from '../auth/rbac.js';
import { assertActive, findDuplicates } from '../../modules/patients/family.js';
import { badRequest, conflict, forbidden, HttpError, mapDbError, notFound } from '../http.js';
import { baseBody, createAppointment } from './appointments.js';

const CAP = { cap: 'crm.pipeline' } as const;
const idParam = z.object({ id: z.string().uuid() });
const STAGES = ['new', 'contacted', 'scheduled', 'won', 'lost'] as const;
const SOURCES = ['referral', 'instagram', 'google', 'website', 'whatsapp', 'walk_in', 'other'] as const;
const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');

const SELECT = `SELECT l.id, l.name, l.phone, l.email, l.source, l.interest, l.stage, l.lost_reason AS "lostReason", l.owner_id AS "ownerId", uo.name AS "ownerName",
    to_char(l.next_contact_on, 'YYYY-MM-DD') AS "nextContactOn", l.marketing_consent AS "marketingConsent", l.patient_id AS "patientId",
    l.created_at AS "createdAt", l.updated_at AS "updatedAt"
  FROM crm_leads l LEFT JOIN users uo ON uo.tenant_id = l.tenant_id AND uo.id = l.owner_id`;

async function event(ctx: ClinicCtx, leadId: string, kind: string, o: { from?: string; to?: string; note?: string | null } = {}) {
  await ctx.tx.query(
    'INSERT INTO crm_lead_events (tenant_id, lead_id, kind, from_stage, to_stage, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [ctx.tenantId, leadId, kind, o.from ?? null, o.to ?? null, o.note ?? null, ctx.user.id]);
}
async function checkOwner(ctx: ClinicCtx, ownerId: string | null | undefined) {
  if (!ownerId) return;
  const r = await ctx.tx.query("SELECT 1 FROM users WHERE id = $1 AND status = 'active'", [ownerId]);
  if (!r.rowCount) throw badRequest('Responsável inválido.');
}

export function crmRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/crm/leads', { ...CAP, perm: 'crm.read' }, async (ctx) => {
    const q = z.object({ stage: z.enum(STAGES).optional(), q: z.string().trim().max(80).optional(), due: z.enum(['1']).optional() }).parse(ctx.req.query);
    const r = await ctx.tx.query(
      `${SELECT} WHERE ($1::text IS NULL OR l.stage = $1) AND ($2::text IS NULL OR l.name ILIKE $2 OR l.phone ILIKE $2 OR l.email ILIKE $2)
         AND ($3::boolean IS NOT TRUE OR (l.stage IN ('new','contacted','scheduled') AND l.next_contact_on <= (now() AT TIME ZONE 'America/Sao_Paulo')::date))
       ORDER BY l.next_contact_on NULLS LAST, l.created_at DESC LIMIT 300`,
      [q.stage ?? null, q.q ? `%${q.q.replace(/[%_]/g, '')}%` : null, q.due === '1']);
    const counts = await ctx.tx.query<{ stage: string; n: number }>('SELECT stage, COUNT(*)::int AS n FROM crm_leads GROUP BY stage');
    const due = await ctx.tx.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM crm_leads WHERE stage IN ('new','contacted','scheduled') AND next_contact_on <= (now() AT TIME ZONE 'America/Sao_Paulo')::date`);
    return { leads: r.rows, counts: Object.fromEntries(STAGES.map((s) => [s, counts.rows.find((c) => c.stage === s)?.n ?? 0])), dueCount: due.rows[0]!.n };
  });

  clinicRoute(app, 'POST', '/api/crm/leads', { ...CAP, perm: 'crm.write' }, async (ctx) => {
    const b = z.object({
      name: z.string().trim().min(2).max(160), phone: opt(30),
      email: z.string().trim().toLowerCase().email('E-mail inválido.').max(200).nullish().or(z.literal('')).transform((v) => v || null),
      source: z.enum(SOURCES).default('other'), interest: opt(200), nextContactOn: ymd.nullish().transform((v) => v ?? null),
      ownerId: z.string().uuid().nullish().transform((v) => v ?? null), marketingConsent: z.boolean().default(false),
    }).parse(ctx.req.body);
    if (!b.phone && !b.email) throw badRequest('Informe telefone ou e-mail para contato.');
    await checkOwner(ctx, b.ownerId);
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO crm_leads (tenant_id, name, phone, email, source, interest, next_contact_on, owner_id, marketing_consent, marketing_consent_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9 THEN now() END, $10) RETURNING id`,
        [ctx.tenantId, b.name, b.phone, b.email, b.source, b.interest, b.nextContactOn, b.ownerId, b.marketingConsent, ctx.user.id]);
      await event(ctx, r.rows[0]!.id, 'created', { to: 'new' });
      if (b.marketingConsent) await event(ctx, r.rows[0]!.id, 'consent', { note: 'Autorizou comunicação de marketing ao se cadastrar' });
      await audit(ctx, 'crm.lead.create', 'crm_lead', r.rows[0]!.id, { source: b.source });
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'GET', '/api/crm/leads/:id', { ...CAP, perm: 'crm.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const l = await ctx.tx.query(`${SELECT} WHERE l.id = $1`, [id]);
    if (!l.rows[0]) throw notFound('Lead não encontrado.');
    const ev = await ctx.tx.query(
      `SELECT e.id, e.kind, e.from_stage AS "fromStage", e.to_stage AS "toStage", e.note, e.created_at AS "createdAt", u.name AS "authorName"
         FROM crm_lead_events e LEFT JOIN users u ON u.tenant_id = e.tenant_id AND u.id = e.created_by WHERE e.lead_id = $1 ORDER BY e.seq`, [id]);
    return { lead: l.rows[0], events: ev.rows };
  });

  // Edição de dados e movimentação no funil. Mudança de etapa e de responsável viram eventos.
  clinicRoute(app, 'PATCH', '/api/crm/leads/:id', { ...CAP, perm: 'crm.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({
      stage: z.enum(['new', 'contacted', 'scheduled', 'lost']).optional(), lostReason: z.string().trim().min(3).max(200).optional(),
      interest: opt(200).optional(), phone: opt(30).optional(), nextContactOn: ymd.nullish().optional(),
      ownerId: z.string().uuid().nullish().optional(), marketingConsent: z.boolean().optional(),
    }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ stage: string; owner_id: string | null; marketing_consent: boolean; patient_id: string | null }>(
      'SELECT stage, owner_id, marketing_consent, patient_id FROM crm_leads WHERE id = $1 FOR UPDATE', [id]);
    const l = cur.rows[0];
    if (!l) throw notFound('Lead não encontrado.');
    if (l.stage === 'won') throw conflict('Lead ganho já virou paciente e não muda de etapa.');
    if (b.stage === 'lost' && !b.lostReason) throw badRequest('Informe o motivo da perda.');
    if (b.ownerId !== undefined) await checkOwner(ctx, b.ownerId);
    const stage = b.stage ?? l.stage;
    try {
      await ctx.tx.query(
        `UPDATE crm_leads SET stage = $2, lost_reason = CASE WHEN $2 = 'lost' THEN COALESCE($3, lost_reason) END,
           interest = CASE WHEN $4::boolean THEN $5 ELSE interest END, phone = CASE WHEN $6::boolean THEN $7 ELSE phone END,
           next_contact_on = CASE WHEN $8::boolean THEN $9::date ELSE next_contact_on END, owner_id = CASE WHEN $10::boolean THEN $11::uuid ELSE owner_id END,
           marketing_consent = COALESCE($12, marketing_consent),
           marketing_consent_at = CASE WHEN $12 IS NULL THEN marketing_consent_at WHEN $12 THEN COALESCE(marketing_consent_at, now()) END
         WHERE id = $1`,
        [id, stage, b.lostReason ?? null, 'interest' in b, b.interest ?? null, 'phone' in b, b.phone ?? null,
         'nextContactOn' in b, b.nextContactOn ?? null, 'ownerId' in b, b.ownerId ?? null, b.marketingConsent ?? null]);
    } catch (e) { return mapDbError(e); }
    if (b.stage && b.stage !== l.stage) await event(ctx, id, 'stage', { from: l.stage, to: b.stage, note: b.lostReason ?? null });
    if ('ownerId' in b && (b.ownerId ?? null) !== l.owner_id) await event(ctx, id, 'assigned');
    if (b.marketingConsent !== undefined && b.marketingConsent !== l.marketing_consent) await event(ctx, id, 'consent', { note: b.marketingConsent ? 'Autorizou comunicação de marketing' : 'Revogou a autorização de marketing' });
    await audit(ctx, 'crm.lead.update', 'crm_lead', id, { stage: b.stage });
    return { ok: true };
  });

  clinicRoute(app, 'POST', '/api/crm/leads/:id/notes', { ...CAP, perm: 'crm.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ note: z.string().trim().min(2).max(500), nextContactOn: ymd.nullish().optional() }).parse(ctx.req.body);
    const r = await ctx.tx.query('SELECT 1 FROM crm_leads WHERE id = $1 FOR UPDATE', [id]);
    if (!r.rowCount) throw notFound('Lead não encontrado.');
    await event(ctx, id, 'note', { note: b.note });
    if (b.nextContactOn !== undefined) await ctx.tx.query('UPDATE crm_leads SET next_contact_on = $2 WHERE id = $1', [id, b.nextContactOn]);
    else await ctx.tx.query('UPDATE crm_leads SET updated_at = now() WHERE id = $1', [id]);
    return { ok: true };
  });

  // Vira paciente (novo cadastro) ou liga a um paciente existente. Exige permissão de cadastrar pacientes.
  clinicRoute(app, 'POST', '/api/crm/leads/:id/convert', { ...CAP, perm: 'crm.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ patientId: z.string().uuid().optional(), confirmNotDuplicate: z.boolean().optional() }).parse(ctx.req.body ?? {});
    return { patientId: await convertLead(ctx, id, b) };
  });

  // Agenda direto a partir do lead: converte em paciente (ou usa o já convertido) e marca a consulta, tudo ou nada.
  clinicRoute(app, 'POST', '/api/crm/leads/:id/schedule', { ...CAP, perm: 'crm.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    if (!hasPermission(ctx.user.role, 'agenda.write') || !ctx.entitlements.has('schedule.core')) throw forbidden('Seu perfil não pode agendar consultas. Peça à recepção.');
    const b = baseBody.omit({ patientId: true }).extend({ patientId: z.string().uuid().optional(), confirmNotDuplicate: z.boolean().optional() }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ patient_id: string | null }>('SELECT patient_id FROM crm_leads WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Lead não encontrado.');
    const patientId = cur.rows[0].patient_id ?? await convertLead(ctx, id, { patientId: b.patientId, confirmNotDuplicate: b.confirmNotDuplicate });
    const appointmentId = await createAppointment(ctx, { ...b, patientId });
    await event(ctx, id, 'note', { note: `Consulta agendada para ${new Date(b.startsAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })}` });
    await audit(ctx, 'crm.lead.schedule', 'crm_lead', id, { appointmentId });
    return { patientId, appointmentId };
  });
}

/** Converte o lead em paciente (novo cadastro ou paciente existente) e o marca como ganho. */
async function convertLead(ctx: ClinicCtx, id: string, b: { patientId?: string; confirmNotDuplicate?: boolean }): Promise<string> {
  if (!hasPermission(ctx.user.role, 'patients.write') || !ctx.entitlements.has('patient.registry')) throw forbidden('Seu perfil não pode cadastrar pacientes. Peça à recepção para converter este lead.');
  const cur = await ctx.tx.query<{ name: string; phone: string | null; email: string | null; stage: string; patient_id: string | null }>(
    'SELECT name, phone, email, stage, patient_id FROM crm_leads WHERE id = $1 FOR UPDATE', [id]);
  const l = cur.rows[0];
  if (!l) throw notFound('Lead não encontrado.');
  if (l.patient_id) throw conflict('Este lead já foi convertido.');
  let patientId = b.patientId;
  if (patientId) {
    await assertActive(ctx.tx, patientId);
  } else {
    if (!b.confirmNotDuplicate) {
      const candidates = await findDuplicates(ctx.tx, { name: l.name, birthDate: null, phone: l.phone, document: null });
      if (candidates.length) throw new HttpError(409, 'Já existe um cadastro parecido. Ligue o lead a ele ou confirme que é outra pessoa.', 'possible_duplicate', { candidates });
    }
    const p = await ctx.tx.query<{ id: string }>(
      'INSERT INTO patients (tenant_id, name, phone, email, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [ctx.tenantId, l.name, l.phone, l.email, ctx.user.id]);
    patientId = p.rows[0]!.id;
    await audit(ctx, 'patient.create', 'patient', patientId, { fromLead: id });
  }
  try {
    await ctx.tx.query("UPDATE crm_leads SET patient_id = $2, stage = 'won', lost_reason = NULL WHERE id = $1", [id, patientId]);
  } catch (e) { return mapDbError(e); }
  await event(ctx, id, 'converted', { from: l.stage, to: 'won' });
  await audit(ctx, 'crm.lead.convert', 'crm_lead', id, { patientId });
  return patientId;
}
