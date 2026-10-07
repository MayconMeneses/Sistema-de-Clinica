import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute } from '../context.js';
import { hasPermission } from '../auth/rbac.js';
import { family } from '../../modules/patients/family.js';
import { badRequest, conflict, mapDbError, notFound } from '../http.js';

const idParam = z.object({ id: z.string().uuid() });
const CAP = { cap: 'patient.registry' } as const;

export function patientAdminRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ revisão de duplicidade e mesclagem
  clinicRoute(app, 'GET', '/api/patients/duplicates', { ...CAP, perm: 'patients.merge' }, async (ctx) => {
    const r = await ctx.tx.query(
      `SELECT a.id AS "aId", a.name AS "aName", to_char(a.birth_date,'YYYY-MM-DD') AS "aBirth", a.phone AS "aPhone",
              b.id AS "bId", b.name AS "bName", to_char(b.birth_date,'YYYY-MM-DD') AS "bBirth", b.phone AS "bPhone",
              CASE WHEN a.doc_digits <> '' AND a.doc_digits = b.doc_digits THEN 'mesmo documento'
                   WHEN a.birth_date IS NOT NULL AND a.name_key = b.name_key AND a.birth_date = b.birth_date THEN 'mesmo nome e nascimento'
                   ELSE 'mesmo telefone e primeiro nome' END AS reason
         FROM patients a JOIN patients b ON a.tenant_id = b.tenant_id AND a.id < b.id
        WHERE a.merged_into IS NULL AND b.merged_into IS NULL
          AND ((a.doc_digits <> '' AND a.doc_digits = b.doc_digits)
               OR (a.birth_date IS NOT NULL AND a.name_key = b.name_key AND a.birth_date = b.birth_date)
               OR (a.phone_digits <> '' AND a.phone_digits = b.phone_digits AND split_part(a.name_key, ' ', 1) = split_part(b.name_key, ' ', 1)))
          AND NOT EXISTS (SELECT 1 FROM patient_duplicate_dismissals d WHERE d.a_id = a.id AND d.b_id = b.id)
        ORDER BY a.name LIMIT 100`);
    return { pairs: r.rows };
  });

  clinicRoute(app, 'POST', '/api/patients/duplicates/dismiss', { ...CAP, perm: 'patients.merge' }, async (ctx) => {
    const b = z.object({ aId: z.string().uuid(), bId: z.string().uuid() }).parse(ctx.req.body);
    if (b.aId === b.bId) throw badRequest('Informe dois cadastros diferentes.');
    const [a, c] = b.aId < b.bId ? [b.aId, b.bId] : [b.bId, b.aId];
    try {
      await ctx.tx.query('INSERT INTO patient_duplicate_dismissals (tenant_id, a_id, b_id, dismissed_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [ctx.tenantId, a, c, ctx.user.id]);
    } catch (e) { return mapDbError(e); }
    await audit(ctx, 'patient.duplicate_dismissed', 'patient', a, { other: c });
    return { ok: true };
  });

  // Mescla `id` (origem) em `intoId` (principal). Nada é apagado: a origem fica como alias do principal.
  clinicRoute(app, 'POST', '/api/patients/:id/merge', { ...CAP, perm: 'patients.merge' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ intoId: z.string().uuid(), reason: z.string().trim().min(5, 'Informe o motivo da mesclagem.').max(300) }).parse(ctx.req.body);
    if (b.intoId === id) throw badRequest('Escolha outro cadastro como principal.');
    const rows = await ctx.tx.query<{ id: string; merged_into: string | null; phone: string | null; email: string | null; document: string | null; birth_date: string | null }>(
      `SELECT id, merged_into, phone, email, document, to_char(birth_date,'YYYY-MM-DD') AS birth_date FROM patients WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [[id, b.intoId]]);
    const src = rows.rows.find((r) => r.id === id), tgt = rows.rows.find((r) => r.id === b.intoId);
    if (!src || !tgt) throw notFound('Cadastro não encontrado.');
    if (src.merged_into) throw conflict('O cadastro de origem já foi mesclado.');
    if (tgt.merged_into) throw conflict('O cadastro principal já foi mesclado a outro. Escolha o cadastro principal atual.');

    try {
      // Dados mutáveis passam para o principal. Conflito de horário entre os dois cadastros impede a mesclagem (nada muda).
      await ctx.tx.query('UPDATE appointments SET patient_id = $2 WHERE patient_id = $1', [id, b.intoId]);
      await ctx.tx.query(`UPDATE waitlist_entries SET patient_id = $2 WHERE patient_id = $1 AND status = 'waiting'`, [id, b.intoId]);
    } catch (e) {
      if ((e as { code?: string }).code === '23P01') throw conflict('Os dois cadastros têm consultas em horários que se sobrepõem. Remarque uma delas e tente de novo.');
      return mapDbError(e);
    }
    // Quem já estava mesclado na origem passa a apontar para o principal.
    await ctx.tx.query('UPDATE patients SET merged_into = $2 WHERE id = $1 OR merged_into = $1', [id, b.intoId]);
    // Contatos ausentes no principal são herdados da origem (informado na auditoria).
    const copied: string[] = [];
    for (const [col, key] of [['phone', 'phone'], ['email', 'email'], ['document', 'document'], ['birth_date', 'birth_date']] as const) {
      if (!tgt[key] && src[key]) { await ctx.tx.query(`UPDATE patients SET ${col} = $2 WHERE id = $1`, [b.intoId, src[key]]); copied.push(col); }
    }
    await ctx.tx.query('INSERT INTO patient_merges (tenant_id, source_id, target_id, reason, copied, merged_by) VALUES ($1,$2,$3,$4,$5,$6)', [ctx.tenantId, id, b.intoId, b.reason, JSON.stringify(copied), ctx.user.id]);
    await audit(ctx, 'patient.merge', 'patient', b.intoId, { source: id, copied });
    return { ok: true, copied };
  });

  // ------------------------------------------------------------ responsáveis
  clinicRoute(app, 'GET', '/api/patients/:id/guardians', { ...CAP, perm: 'patients.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query(
      `SELECT id, name, relationship, phone, email, document, legal_guardian AS "legalGuardian", guardian_patient_id AS "guardianPatientId", created_at AS "createdAt"
         FROM patient_guardians WHERE patient_id = ANY($1::uuid[]) AND ended_at IS NULL ORDER BY legal_guardian DESC, created_at`, [await family(ctx.tx, id)]);
    return { guardians: r.rows };
  });

  clinicRoute(app, 'POST', '/api/patients/:id/guardians', { ...CAP, perm: 'patients.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const opt = (n: number) => z.string().trim().max(n).nullish().transform((v) => v || null);
    const b = z.object({
      name: z.string().trim().min(2, 'Informe o nome.').max(160), relationship: z.string().trim().min(2, 'Informe o parentesco.').max(60),
      phone: opt(30), email: z.string().trim().toLowerCase().email('E-mail inválido.').max(200).nullish().or(z.literal('')).transform((v) => v || null),
      document: opt(30), legalGuardian: z.boolean().default(false),
      guardianPatientId: z.string().uuid().nullish().transform((v) => v ?? null),
    }).parse(ctx.req.body);
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO patient_guardians (tenant_id, patient_id, guardian_patient_id, name, relationship, phone, email, document, legal_guardian, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [ctx.tenantId, id, b.guardianPatientId, b.name, b.relationship, b.phone, b.email, b.document, b.legalGuardian, ctx.user.id]);
      await audit(ctx, 'guardian.add', 'patient', id, { guardianId: r.rows[0]!.id });
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'DELETE', '/api/patients/:id/guardians/:gid', { ...CAP, perm: 'patients.write' }, async (ctx) => {
    const { id, gid } = z.object({ id: z.string().uuid(), gid: z.string().uuid() }).parse(ctx.req.params);
    const r = await ctx.tx.query('UPDATE patient_guardians SET ended_at = now() WHERE id = $1 AND patient_id = $2 AND ended_at IS NULL', [gid, id]);
    if (!r.rowCount) throw notFound('Responsável não encontrado.');
    await audit(ctx, 'guardian.end', 'patient', id, { guardianId: gid });
    return { ok: true };
  });

  // ------------------------------------------------------------ solicitações de privacidade (direitos do titular)
  clinicRoute(app, 'GET', '/api/patients/:id/privacy', { ...CAP, perm: 'privacy.open' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query(
      `SELECT id, kind, status, details, opened_at AS "openedAt", due_at AS "dueAt", resolved_at AS "resolvedAt", resolution FROM privacy_requests WHERE patient_id = ANY($1::uuid[]) ORDER BY opened_at DESC`, [await family(ctx.tx, id)]);
    return { requests: r.rows };
  });

  clinicRoute(app, 'POST', '/api/patients/:id/privacy', { ...CAP, perm: 'privacy.open' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ kind: z.enum(['access', 'correction', 'export', 'deletion', 'objection', 'information']), details: z.string().trim().max(1000).nullish().transform((v) => v || null) }).parse(ctx.req.body);
    try {
      const r = await ctx.tx.query<{ id: string; due_at: Date }>(
        'INSERT INTO privacy_requests (tenant_id, patient_id, kind, details, opened_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, due_at', [ctx.tenantId, id, b.kind, b.details, ctx.user.id]);
      await audit(ctx, 'privacy.open', 'patient', id, { requestId: r.rows[0]!.id, kind: b.kind });
      return { id: r.rows[0]!.id, dueAt: r.rows[0]!.due_at };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'GET', '/api/privacy/requests', { ...CAP, perm: 'privacy.manage' }, async (ctx) => {
    const r = await ctx.tx.query(
      `SELECT q.id, q.kind, q.status, q.details, q.opened_at AS "openedAt", q.due_at AS "dueAt", (q.due_at < now()) AS overdue, p.id AS "patientId", p.name AS "patientName"
         FROM privacy_requests q JOIN patients p ON p.tenant_id = q.tenant_id AND p.id = q.patient_id
        WHERE q.status IN ('open','in_progress') ORDER BY q.due_at LIMIT 200`);
    return { requests: r.rows };
  });

  clinicRoute(app, 'PATCH', '/api/privacy/requests/:id', { ...CAP, perm: 'privacy.manage' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ status: z.enum(['in_progress', 'done', 'rejected']), resolution: z.string().trim().max(1000).optional() }).parse(ctx.req.body);
    if (b.status !== 'in_progress' && (b.resolution ?? '').length < 5) throw badRequest('Descreva a resposta ou o motivo (mín. 5 caracteres).');
    const cur = await ctx.tx.query<{ status: string }>('SELECT status FROM privacy_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Solicitação não encontrada.');
    if (['done', 'rejected'].includes(cur.rows[0].status)) throw conflict('Solicitação já resolvida.');
    const final = b.status !== 'in_progress';
    try {
      await ctx.tx.query(
        `UPDATE privacy_requests SET status = $1, resolution = $2, resolved_by = CASE WHEN $3 THEN $4::uuid END, resolved_at = CASE WHEN $3 THEN now() END WHERE id = $5`,
        [b.status, final ? b.resolution : null, final, ctx.user.id, id]);
    } catch (e) { return mapDbError(e); }
    await audit(ctx, `privacy.${b.status}`, 'privacy_request', id);
    return { ok: true };
  });

  // ------------------------------------------------------------ exportação dos dados do paciente (acesso/portabilidade)
  // Respeita as permissões de quem exporta: seções que o perfil não pode ler são omitidas e listadas em "omitted".
  clinicRoute(app, 'GET', '/api/patients/:id/export', { ...CAP, perm: 'patients.export' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const ids = await family(ctx.tx, id);
    const patients = await ctx.tx.query(
      `SELECT id, name, social_name AS "socialName", to_char(birth_date,'YYYY-MM-DD') AS "birthDate", phone, email, document,
              ${hasPermission(ctx.user.role, 'notes.read') ? 'alert,' : ''} created_at AS "createdAt", merged_into AS "mergedInto" FROM patients WHERE id = ANY($1::uuid[])`, [ids]);
    if (!patients.rowCount) throw notFound('Paciente não encontrado.');
    const q = async (sql: string) => (await ctx.tx.query(sql, [ids])).rows;
    const out: Record<string, unknown> = {
      generatedAt: new Date().toISOString(), generatedBy: ctx.user.name, format: 'clinica-one/export/v1',
      records: patients.rows,
      guardians: await q(`SELECT name, relationship, phone, email, document, legal_guardian AS "legalGuardian", created_at AS "createdAt", ended_at AS "endedAt" FROM patient_guardians WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at`),
      consents: await q(`SELECT purpose, granted, policy_version AS "policyVersion", source, created_at AS "createdAt" FROM patient_consents WHERE patient_id = ANY($1::uuid[]) ORDER BY seq`),
      appointments: await q(`SELECT a.starts_at AS "startsAt", a.ends_at AS "endsAt", a.status, a.service, a.price_cents::text AS "priceCents", u.name AS professional FROM appointments a JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.professional_id WHERE a.patient_id = ANY($1::uuid[]) ORDER BY a.starts_at`),
      merges: await q(`SELECT source_id AS "sourceId", target_id AS "targetId", reason, created_at AS "createdAt" FROM patient_merges WHERE source_id = ANY($1::uuid[]) OR target_id = ANY($1::uuid[]) ORDER BY created_at`),
      privacyRequests: await q(`SELECT kind, status, details, opened_at AS "openedAt", due_at AS "dueAt", resolved_at AS "resolvedAt", resolution FROM privacy_requests WHERE patient_id = ANY($1::uuid[]) ORDER BY opened_at`),
    };
    const omitted: { section: string; reason: string }[] = [];
    const gate = async (section: string, cap: string, perm: string, sql: string) => {
      if (!ctx.entitlements.has(cap)) omitted.push({ section, reason: 'recurso não contratado' });
      else if (!hasPermission(ctx.user.role, perm)) omitted.push({ section, reason: 'seu perfil não tem acesso a esta seção' });
      else out[section] = await q(sql);
    };
    await gate('clinicalNotes', 'clinical.record', 'notes.read', `SELECT n.created_at AS "createdAt", n.status, n.signed_at AS "signedAt", n.addendum_reason AS "addendumReason", n.body, u.name AS author FROM clinical_notes n JOIN users u ON u.tenant_id = n.tenant_id AND u.id = n.author_id WHERE n.patient_id = ANY($1::uuid[]) ORDER BY n.created_at`);
    await gate('finance', 'finance.basic', 'finance.read', `SELECT kind, method, amount_cents::text AS "amountCents", note, created_at AS "createdAt" FROM financial_movements WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at`);
    await gate('dentalFindings', 'dental.odontogram', 'dental.read', `SELECT tooth, surface, condition, note, created_at AS "createdAt" FROM dental_findings WHERE patient_id = ANY($1::uuid[]) ORDER BY seq`);
    await gate('dentalPlan', 'dental.odontogram', 'dental.read', `SELECT tooth, procedure, price_cents::text AS "priceCents", status, created_at AS "createdAt" FROM dental_plan_items WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at`);
    await gate('dentalQuotes', 'dental.odontogram', 'dental.read', `SELECT q.version, q.status, q.notes, q.valid_until AS "validUntil", q.created_at AS "createdAt", q.presented_at AS "presentedAt", q.decided_at AS "decidedAt", q.accepted_by_name AS "acceptedByName", q.accepted_by_role AS "acceptedByRole",
      (SELECT json_agg(json_build_object('tooth', i.tooth, 'procedure', i.procedure, 'priceCents', i.price_cents::text) ORDER BY i.position) FROM dental_quote_items i WHERE i.tenant_id = q.tenant_id AND i.quote_id = q.id) AS items
      FROM dental_quotes q WHERE q.patient_id = ANY($1::uuid[]) ORDER BY q.created_at`);
    await gate('messages', 'communication.inbox', 'comm.read', `SELECT payload->>'template' AS template, payload->>'channel' AS channel, status, created_at AS "createdAt" FROM outbox_events WHERE topic = 'message.send' AND payload->>'patientId' = ANY($1::text[]) ORDER BY created_at`);
    out.omitted = omitted;
    await audit(ctx, 'patient.export', 'patient', id, { sections: Object.keys(out).filter((k) => !['generatedAt', 'generatedBy', 'format', 'omitted'].includes(k)), omitted: omitted.map((o) => o.section) });
    return out;
  });
}
