import { assertWithinPlan } from '../limits.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute } from '../context.js';
import { assertActive, family } from '../../modules/patients/family.js';
import { hasPermission } from '../auth/rbac.js';
import { badRequest, conflict, forbidden, HttpError, isRealDate, mapDbError, notFound } from '../http.js';

const CAP = { cap: 'clinical.record' } as const;
const idParam = z.object({ id: z.string().uuid() });
const MAX_BYTES = 5 * 1024 * 1024;
const BODY_LIMIT = Math.ceil(MAX_BYTES * 4 / 3) + 4096;   // base64 + campos do JSON
const CATEGORIES = ['exam', 'report', 'consent', 'identity', 'other', 'xray', 'photo'] as const;
const IMAGE_CATEGORIES = ['xray', 'photo'];
const TOOTH = /^(1[1-8]|2[1-8]|3[1-8]|4[1-8]|5[1-5]|6[1-5]|7[1-5]|8[1-5])$/;
const MAX_THUMB = 80 * 1024;
/** Exames, laudos, radiografias e fotos clínicas são dado clínico: seguem a mesma segregação do prontuário (recepção e administração não leem nem anexam). */
export const CLINICAL_CATEGORIES = ['exam', 'report', 'xray', 'photo'];
const canClinical = (role: string) => hasPermission(role, 'notes.read');

/** Tipo verdadeiro pelo conteúdo (não pelo nome/cabeçalho enviado pelo cliente). */
export function sniffMime(b: Buffer): 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const safeName = (n: string) => n.replace(/\.{2,}/g, '.').replace(/^\.+/, '').replace(/[\r\n"\\/]/g, '_').replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 160) || 'documento';

export function documentRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/patients/:id/documents', { ...CAP, perm: 'documents.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const q = z.object({ includeArchived: z.enum(['1']).optional(), kind: z.enum(['files', 'images']).default('files'), tooth: z.string().regex(TOOTH).optional() }).parse(ctx.req.query);
    const r = await ctx.tx.query(
      `SELECT d.id, d.title, d.category, d.file_name AS "fileName", d.mime_type AS "mimeType", d.size_bytes AS "sizeBytes",
              d.created_at AS "createdAt", u.name AS "authorName", d.shared_with_patient AS "sharedWithPatient", d.tooth, to_char(d.taken_on, 'YYYY-MM-DD') AS "takenOn", (d.thumbnail IS NOT NULL) AS "hasThumbnail", d.archived_at AS "archivedAt", d.archive_reason AS "archiveReason"
         FROM patient_documents d LEFT JOIN users u ON u.tenant_id = d.tenant_id AND u.id = d.created_by
        WHERE d.patient_id = ANY($1::uuid[]) AND ($2::boolean OR d.archived_at IS NULL) AND ($3::boolean OR d.category <> ALL($4::text[]))
          AND (($5 = 'images') = (d.category = ANY($6::text[]))) AND ($7::text IS NULL OR d.tooth = $7)
        ORDER BY COALESCE(d.taken_on, d.created_at::date) DESC, d.created_at DESC LIMIT 200`,
      [await family(ctx.tx, id), q.includeArchived === '1', canClinical(ctx.user.role), CLINICAL_CATEGORIES, q.kind, IMAGE_CATEGORIES, q.tooth ?? null]);
    if (q.kind === 'images' && r.rowCount) await audit(ctx, 'document.images_listed', 'patient', id, { count: r.rowCount });
    return { documents: r.rows };
  });

  clinicRoute(app, 'POST', '/api/patients/:id/documents', { ...CAP, perm: 'documents.write', bodyLimit: BODY_LIMIT }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({
      title: z.string().trim().min(2).max(120),
      category: z.enum(CATEGORIES),
      fileName: z.string().trim().min(1).max(160),
      contentBase64: z.string().min(4).max(BODY_LIMIT),
      tooth: z.string().regex(TOOTH, 'Dente inválido (numeração FDI).').optional(),
      takenOn: z.string().refine((v) => isRealDate(v) && v >= '1990-01-01' && v <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), 'Data do exame inválida.').optional(),
      thumbnailBase64: z.string().max(Math.ceil(MAX_THUMB * 4 / 3) + 16).optional(),
    }).parse(ctx.req.body);
    if (CLINICAL_CATEGORIES.includes(b.category) && !canClinical(ctx.user.role)) throw forbidden('Exames e laudos só podem ser anexados por quem tem acesso ao prontuário.');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b.contentBase64) || b.contentBase64.length % 4 !== 0) throw badRequest('Arquivo inválido.');
    const buf = Buffer.from(b.contentBase64, 'base64');
    if (buf.length === 0) throw badRequest('O arquivo está vazio.');
    if (buf.length > MAX_BYTES) throw new HttpError(413, 'O arquivo passa de 5 MB.', 'file_too_large');
    const mime = sniffMime(buf);
    if (!mime) throw badRequest('Tipo não aceito. Envie PDF, PNG, JPG ou WEBP.');
    const isImage = IMAGE_CATEGORIES.includes(b.category);
    if (isImage && !mime.startsWith('image/')) throw badRequest('Radiografias e fotos precisam ser imagens (PNG, JPG ou WEBP).');
    if (!isImage && (b.tooth || b.takenOn || b.thumbnailBase64)) throw badRequest('Dente, data do exame e miniatura só valem para radiografias e fotos.');
    let thumb: Buffer | null = null;
    if (b.thumbnailBase64) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b.thumbnailBase64) || b.thumbnailBase64.length % 4 !== 0) throw badRequest('Miniatura inválida.');
      thumb = Buffer.from(b.thumbnailBase64, 'base64');
      if (thumb.length === 0 || thumb.length > MAX_THUMB || sniffMime(thumb) !== 'image/jpeg') throw badRequest('A miniatura precisa ser um JPEG de até 80 KB.');
    }
    await assertActive(ctx.tx, id);
    await assertWithinPlan(ctx.tx, 'storage', buf.length / 1_048_576);
    try {
      const r = await ctx.tx.query<{ id: string }>(
        `INSERT INTO patient_documents (tenant_id, patient_id, title, category, file_name, mime_type, size_bytes, sha256, content, created_by, tooth, taken_on, thumbnail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [ctx.tenantId, id, b.title, b.category, safeName(b.fileName), mime, buf.length, createHash('sha256').update(buf).digest('hex'), buf, ctx.user.id, b.tooth ?? null, b.takenOn ?? null, thumb]);
      await audit(ctx, 'document.create', 'patient_document', r.rows[0]!.id, { patientId: id, category: b.category, size: buf.length });
      return { id: r.rows[0]!.id };
    } catch (e) { return mapDbError(e); }
  });

  clinicRoute(app, 'GET', '/api/documents/:id/download', { ...CAP, perm: 'documents.read' }, async (ctx, _req, reply) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query<{ patient_id: string; file_name: string; mime_type: string; content: Buffer; sha256: string; category: string }>(
      'SELECT patient_id, file_name, mime_type, content, sha256, category FROM patient_documents WHERE id = $1', [id]);
    const d = r.rows[0];
    if (!d || (CLINICAL_CATEGORIES.includes(d.category) && !canClinical(ctx.user.role))) throw notFound('Documento não encontrado.');
    if (createHash('sha256').update(d.content).digest('hex') !== d.sha256) throw new HttpError(500, 'O documento falhou na verificação de integridade.', 'integrity');
    await audit(ctx, 'document.read', 'patient_document', id, { patientId: d.patient_id });
    reply.header('content-type', d.mime_type).header('content-disposition', `attachment; filename="${safeName(d.file_name)}"`)
      .header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store');
    return reply.send(d.content);
  });

  // Exibição na tela (miniatura e imagem inteira). A imagem é servida "inline" só para tipos de imagem, sem permitir execução de conteúdo.
  const IMG_HEADERS = { 'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' };
  clinicRoute(app, 'GET', '/api/documents/:id/thumb', { ...CAP, perm: 'documents.read' }, async (ctx, _req, reply) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query<{ thumbnail: Buffer | null; category: string }>('SELECT thumbnail, category FROM patient_documents WHERE id = $1', [id]);
    const d = r.rows[0];
    if (!d || !d.thumbnail || (CLINICAL_CATEGORIES.includes(d.category) && !canClinical(ctx.user.role))) throw notFound('Miniatura não encontrada.');
    reply.headers({ ...IMG_HEADERS, 'content-type': 'image/jpeg', 'content-disposition': 'inline' });
    return reply.send(d.thumbnail);
  });

  clinicRoute(app, 'GET', '/api/documents/:id/image', { ...CAP, perm: 'documents.read' }, async (ctx, _req, reply) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query<{ patient_id: string; mime_type: string; content: Buffer; sha256: string; category: string }>(
      'SELECT patient_id, mime_type, content, sha256, category FROM patient_documents WHERE id = $1', [id]);
    const d = r.rows[0];
    if (!d || (CLINICAL_CATEGORIES.includes(d.category) && !canClinical(ctx.user.role))) throw notFound('Imagem não encontrada.');
    if (!d.mime_type.startsWith('image/')) throw badRequest('Este documento não é uma imagem.');
    if (createHash('sha256').update(d.content).digest('hex') !== d.sha256) throw new HttpError(500, 'O documento falhou na verificação de integridade.', 'integrity');
    await audit(ctx, 'document.read', 'patient_document', id, { patientId: d.patient_id, view: 'image' });
    reply.headers({ ...IMG_HEADERS, 'content-type': d.mime_type, 'content-disposition': 'inline' });
    return reply.send(d.content);
  });

  clinicRoute(app, 'POST', '/api/documents/:id/archive', { ...CAP, perm: 'documents.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ reason: z.string().trim().min(3).max(200) }).parse(ctx.req.body);
    const cur = await ctx.tx.query<{ archived_at: Date | null; category: string }>('SELECT archived_at, category FROM patient_documents WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0] || (CLINICAL_CATEGORIES.includes(cur.rows[0].category) && !canClinical(ctx.user.role))) throw notFound('Documento não encontrado.');
    if (cur.rows[0].archived_at) throw conflict('Este documento já foi arquivado.');
    await ctx.tx.query('UPDATE patient_documents SET archived_at = now(), archived_by = $2, archive_reason = $3 WHERE id = $1', [id, ctx.user.id, b.reason]);
    await audit(ctx, 'document.archive', 'patient_document', id);
    return { ok: true };
  });
}
