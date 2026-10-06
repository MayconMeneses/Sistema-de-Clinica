import type { FastifyInstance } from 'fastify';
import { integrationEnv } from '../config.js';
import { verifyGeneric, verifyMeta, parseGeneric, parseMeta, type NormalizedEvent } from '../../integrations/webhooks.js';
import { processReceipts } from '../../worker/receipts.js';
import { workerPool } from '../db.js';
import { HttpError } from '../http.js';
import { timingSafeEqual } from 'node:crypto';

/**
 * Webhooks de provedores. Não usam cookie (sem CSRF): a autenticidade vem da assinatura HMAC sobre o corpo BRUTO.
 * Sem segredo configurado a rota recusa tudo (503): nunca aceita evento sem assinatura.
 */
export async function webhookRoutes(app: FastifyInstance) {
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    scope.get('/api/webhooks/whatsapp', async (req, reply) => {
      const { verifyToken } = integrationEnv().whatsapp;
      const q = req.query as Record<string, string | undefined>;
      if (!verifyToken) throw new HttpError(503, 'Webhook não configurado.', 'not_configured');
      const ok = q['hub.mode'] === 'subscribe' && !!q['hub.verify_token'] && q['hub.verify_token'].length === verifyToken.length
        && timingSafeEqual(Buffer.from(q['hub.verify_token']), Buffer.from(verifyToken));
      if (!ok || !q['hub.challenge']) throw new HttpError(403, 'Verificação recusada.', 'forbidden');
      return reply.type('text/plain').send(q['hub.challenge'].slice(0, 200));
    });

    scope.post('/api/webhooks/:provider', async (req, reply) => {
      const { provider } = req.params as { provider: string };
      const raw = req.body as Buffer;
      let events: NormalizedEvent[];
      if (provider === 'whatsapp') {
        const secret = integrationEnv().whatsapp.appSecret;
        if (!secret) throw new HttpError(503, 'Webhook não configurado.', 'not_configured');
        if (!verifyMeta(secret, raw, req.headers['x-hub-signature-256'] as string | undefined)) throw new HttpError(401, 'Assinatura inválida.', 'bad_signature');
        events = parseMeta(JSON.parse(raw.toString('utf8') || '{}'));
      } else if (provider === 'generic') {
        const secret = integrationEnv().webhookSecretGeneric;
        if (!secret) throw new HttpError(503, 'Webhook não configurado.', 'not_configured');
        if (!verifyGeneric(secret, req.headers['x-timestamp'] as string | undefined, raw, req.headers['x-signature'] as string | undefined)) throw new HttpError(401, 'Assinatura inválida ou fora da janela de tempo.', 'bad_signature');
        events = parseGeneric(JSON.parse(raw.toString('utf8') || '{}'));
      } else {
        throw new HttpError(404, 'Provedor desconhecido.', 'not_found');
      }

      let stored = 0;
      for (const e of events) {
        const r = await workerPool.query(
          `INSERT INTO webhook_receipts (provider, external_event_id, external_message_id, event_status) VALUES ($1,$2,$3,$4) ON CONFLICT (provider, external_event_id) DO NOTHING`,
          [provider, e.externalEventId, e.externalMessageId, e.status]);
        stored += r.rowCount ?? 0;
      }
      await processReceipts(workerPool).catch(() => undefined); // melhor esforço; o worker repete
      return reply.status(200).send({ received: events.length, stored, duplicates: events.length - stored });
    });
  });
}
