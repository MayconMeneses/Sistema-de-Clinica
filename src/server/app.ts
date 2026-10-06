import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config } from './config.js';
import { appPool, platformPool } from './db.js';
import { errorHandler } from './http.js';
import { appointmentRoutes } from './routes/appointments.js';
import { authRoutes } from './routes/auth.js';
import { financeRoutes } from './routes/finance.js';
import { masterRoutes } from './routes/master.js';
import { noteRoutes } from './routes/notes.js';
import { patientRoutes } from './routes/patients.js';
import { teamRoutes } from './routes/team.js';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 256 * 1024,
    trustProxy: process.env.TRUST_PROXY === '1',
    genReqId: () => crypto.randomUUID(),
  });
  app.setErrorHandler(errorHandler);
  await app.register(cookie);

  app.addHook('onRequest', async (req, reply) => {
    // CSRF: cookies são SameSite=Strict; além disso mutações exigem cabeçalho customizado e Origin coerente.
    if (req.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      const bad = req.headers['x-requested-with'] !== 'clinica-one' || (origin && new URL(origin).host !== req.headers.host);
      if (bad) return reply.status(403).send({ error: 'csrf', message: 'Requisição bloqueada.', requestId: req.id });
    }
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('content-security-policy', CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('x-request-id', req.id);
    if (config.isProd) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/ready', async (_req, reply) => {
    try {
      await appPool.query('SELECT 1');
      await platformPool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  authRoutes(app);
  masterRoutes(app);
  patientRoutes(app);
  appointmentRoutes(app);
  noteRoutes(app);
  financeRoutes(app);
  teamRoutes(app);

  const webDir = join(import.meta.dirname, '..', '..', 'web', 'dist');
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').sendFile('index.html');
      return reply.status(404).send({ error: 'not_found', message: 'Não encontrado.', requestId: req.id });
    });
  }

  app.addHook('onClose', async () => { await appPool.end(); await platformPool.end(); });
  return app;
}
