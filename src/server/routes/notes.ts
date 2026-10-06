import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute } from '../context.js';
import { assertActive, family } from '../../modules/patients/family.js';
import { conflict, forbidden, mapDbError, notFound } from '../http.js';

const body = z.object({ body: z.string().trim().min(1, 'Escreva o registro.').max(20000) });
const idParam = z.object({ id: z.string().uuid() });
const CLINICAL = { cap: 'clinical.record' } as const;

export function noteRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/patients/:id/notes', { ...CLINICAL, perm: 'notes.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query(
      `SELECT n.id, n.body, n.status, n.signed_at AS "signedAt", n.created_at AS "createdAt", n.updated_at AS "updatedAt",
              n.parent_note_id AS "parentNoteId", n.addendum_reason AS "addendumReason",
              n.author_id AS "authorId", u.name AS "authorName"
         FROM clinical_notes n JOIN users u ON u.tenant_id = n.tenant_id AND u.id = n.author_id
        WHERE n.patient_id = ANY($1::uuid[]) ORDER BY n.created_at`, [await family(ctx.tx, id)]);
    await audit(ctx, 'record.read', 'patient', id, { notes: r.rowCount });
    return { notes: r.rows };
  });

  clinicRoute(app, 'POST', '/api/patients/:id/notes', { ...CLINICAL, perm: 'notes.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = body.parse(ctx.req.body);
    await assertActive(ctx.tx, id);
    try {
      const r = await ctx.tx.query<{ id: string }>(
        'INSERT INTO clinical_notes (tenant_id, patient_id, author_id, body) VALUES ($1,$2,$3,$4) RETURNING id',
        [ctx.tenantId, id, ctx.user.id, b.body]);
      await audit(ctx, 'note.create', 'note', r.rows[0]!.id, { patientId: id });
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'PATCH', '/api/notes/:id', { ...CLINICAL, perm: 'notes.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = body.parse(ctx.req.body);
    const cur = await ctx.tx.query<{ author_id: string; status: string }>('SELECT author_id, status FROM clinical_notes WHERE id = $1 FOR UPDATE', [id]);
    const note = cur.rows[0];
    if (!note) throw notFound('Registro não encontrado.');
    if (note.author_id !== ctx.user.id) throw forbidden('Somente o autor edita o rascunho.');
    if (note.status === 'signed') throw conflict('Registro assinado é imutável. Crie um adendo.');
    await ctx.tx.query('UPDATE clinical_notes SET body = $1, updated_at = now() WHERE id = $2', [b.body, id]);
    await audit(ctx, 'note.update_draft', 'note', id);
    return { ok: true };
  });

  clinicRoute(app, 'POST', '/api/notes/:id/sign', { ...CLINICAL, perm: 'notes.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const cur = await ctx.tx.query<{ author_id: string; status: string }>('SELECT author_id, status FROM clinical_notes WHERE id = $1 FOR UPDATE', [id]);
    const note = cur.rows[0];
    if (!note) throw notFound('Registro não encontrado.');
    if (note.author_id !== ctx.user.id) throw forbidden('Somente o autor assina o registro.');
    if (note.status === 'signed') throw conflict('Registro já assinado.');
    await ctx.tx.query(`UPDATE clinical_notes SET status = 'signed', signed_at = now() WHERE id = $1`, [id]);
    await audit(ctx, 'note.sign', 'note', id);
    return { ok: true };
  });

  clinicRoute(app, 'POST', '/api/notes/:id/addendum', { ...CLINICAL, perm: 'notes.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ body: body.shape.body, reason: z.string().trim().min(5, 'Informe a justificativa do adendo.').max(500) }).parse(ctx.req.body);
    const parent = await ctx.tx.query<{ patient_id: string }>('SELECT patient_id FROM clinical_notes WHERE id = $1', [id]);
    if (!parent.rows[0]) throw notFound('Registro não encontrado.');
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO clinical_notes (tenant_id, patient_id, author_id, body, parent_note_id, addendum_reason, status, signed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'signed', now()) RETURNING id`,
        [ctx.tenantId, parent.rows[0].patient_id, ctx.user.id, b.body, id, b.reason]);
      await audit(ctx, 'note.addendum', 'note', r.rows[0]!.id, { parent: id });
      return { id: r.rows[0]!.id };
    } catch (e) {
      if ((e as { code?: string }).code === '23514') throw conflict('Adendo exige um registro já assinado.');
      return mapDbError(e);
    }
  });
}
