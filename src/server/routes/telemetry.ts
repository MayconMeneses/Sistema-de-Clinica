import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notify, scrub } from '../../ops/alerts.js';

/**
 * Erros que acontecem no navegador (tela quebrada). Rota sem login, por isso: corpo minúsculo, limite por IP e global,
 * texto higienizado (ids, e-mails e números longos somem) e nada é gravado: vira apenas um aviso para a equipe.
 */
const perIp = new Map<string, { n: number; reset: number }>();
let global = { n: 0, reset: 0 };
const IP_MAX = 5, GLOBAL_MAX = 30;

export function telemetryRoutes(app: FastifyInstance) {
  app.post('/api/telemetry/client-error', { bodyLimit: 2048 }, async (req, reply) => {
    const now = Date.now();
    if (now > global.reset) global = { n: 0, reset: now + 3_600_000 };
    const e = perIp.get(req.ip);
    const slot = !e || now > e.reset ? { n: 0, reset: now + 60_000 } : e;
    perIp.set(req.ip, slot);
    if (perIp.size > 1000) perIp.clear();
    if (++slot.n > IP_MAX || ++global.n > GLOBAL_MAX) return reply.status(204).send(); // descarta em silêncio
    const b = z.object({ message: z.string().max(300), page: z.string().max(120).optional() }).safeParse(req.body);
    if (!b.success) return reply.status(400).send({ error: 'bad_request', message: 'Requisição inválida.', requestId: req.id });
    const page = (b.data.page ?? '').replace(/\?.*$/, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id');
    notify({ severity: 'warning', component: 'web', title: 'Erro na tela do usuário', detail: scrub(b.data.message), route: page ? `tela ${scrub(page, 100)}` : undefined });
    return reply.status(204).send();
  });
}
