import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute } from '../context.js';
import { notFound } from '../http.js';

const idParam = z.object({ id: z.string().uuid() });
const PURPOSES = ['communication_whatsapp', 'communication_email', 'communication_sms'] as const;

export function communicationRoutes(app: FastifyInstance) {
  clinicRoute(app, 'GET', '/api/patients/:id/consents', { cap: 'patient.registry', perm: 'patients.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query(
      `SELECT DISTINCT ON (c.purpose) c.purpose, c.granted, c.policy_version AS "policyVersion", c.source, c.created_at AS "createdAt", u.name AS "recordedBy"
         FROM patient_consents c LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.recorded_by
        WHERE c.patient_id = $1 ORDER BY c.purpose, c.seq DESC`, [id]);
    return { consents: r.rows };
  });

  clinicRoute(app, 'POST', '/api/patients/:id/consents', { cap: 'patient.registry', perm: 'patients.write' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const b = z.object({ purpose: z.enum(PURPOSES), granted: z.boolean() }).parse(ctx.req.body);
    const p = await ctx.tx.query('SELECT 1 FROM patients WHERE id = $1', [id]);
    if (!p.rowCount) throw notFound('Paciente não encontrado.');
    await ctx.tx.query(
      `INSERT INTO patient_consents (tenant_id, patient_id, purpose, granted, source, recorded_by) VALUES ($1,$2,$3,$4,'staff',$5)`,
      [ctx.tenantId, id, b.purpose, b.granted, ctx.user.id]);
    await audit(ctx, b.granted ? 'consent.grant' : 'consent.revoke', 'patient', id, { purpose: b.purpose });
    return { ok: true };
  });

  clinicRoute(app, 'GET', '/api/patients/:id/messages', { cap: 'communication.inbox', perm: 'comm.read' }, async (ctx) => {
    const { id } = idParam.parse(ctx.req.params);
    const r = await ctx.tx.query(
      `SELECT id, payload->>'template' AS template, payload->>'channel' AS channel, status, delivery_status AS "deliveryStatus",
              attempts, last_error AS "reason", next_attempt_at AS "scheduledFor", created_at AS "createdAt", processed_at AS "processedAt"
         FROM outbox_events WHERE topic = 'message.send' AND payload->>'patientId' = $1 ORDER BY created_at DESC LIMIT 100`, [id]);
    return { messages: r.rows };
  });
}
