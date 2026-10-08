import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config } from './config.js';
import { initAlerts } from '../ops/alerts.js';
import { appPool, platformPool } from './db.js';
import { errorHandler } from './http.js';
import { appointmentRoutes } from './routes/appointments.js';
import { authRoutes } from './routes/auth.js';
import { cashRoutes } from './routes/cash.js';
import { commissionRoutes } from './routes/commissions.js';
import { communicationRoutes } from './routes/communications.js';
import { crmRoutes } from './routes/crm.js';
import { dentalQuoteRoutes } from './routes/dental-quotes.js';
import { dentalRoutes } from './routes/dental.js';
import { financeRoutes } from './routes/finance.js';
import { inventoryRoutes } from './routes/inventory.js';
import { masterRoutes } from './routes/master.js';
import { documentRoutes } from './routes/documents.js';
import { noteRoutes } from './routes/notes.js';
import { payableRoutes } from './routes/payables.js';
import { paymentRoutes } from './routes/payments.js';
import { patientAdminRoutes } from './routes/patient-admin.js';
import { patientRoutes } from './routes/patients.js';
import { purchasingRoutes } from './routes/purchasing.js';
import { reportRoutes } from './routes/reports.js';
import { scheduleRoutes } from './routes/schedule.js';
import { teamRoutes } from './routes/team.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { webhookRoutes } from './routes/webhooks.js';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Logs sem dados de paciente: a query string (ex.: busca por nome/CPF) nunca é registrada. */
function loggerConfig(opts: { logger?: boolean; logStream?: NodeJS.WritableStream }) {
  if (!opts.logger && !opts.logStream) return false;
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(opts.logStream ? { stream: opts.logStream } : {}),
    serializers: {
      req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, path: req.url.split('?')[0], ip: req.ip }),
    },
  };
}

export async function buildApp(opts: { logger?: boolean; logStream?: NodeJS.WritableStream } = {}) {
  const app = Fastify({
    logger: loggerConfig(opts),
    bodyLimit: 256 * 1024,
    trustProxy: process.env.TRUST_PROXY === '1',
    genReqId: () => crypto.randomUUID(),
  });
  initAlerts(platformPool);
  app.setErrorHandler(errorHandler);
  await app.register(cookie);

  app.addHook('onRequest', async (req, reply) => {
    // CSRF: cookies são SameSite=Strict; além disso mutações exigem cabeçalho customizado e Origin coerente.
    // Webhooks não usam cookie: autenticam por assinatura HMAC (ver routes/webhooks.ts).
    if (req.url.startsWith('/api/') && !req.url.startsWith('/api/webhooks/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      let originOk = true;
      if (origin) { try { originOk = new URL(origin).host === req.headers.host; } catch { originOk = false; } } // "null" ou malformado => bloqueia
      const bad = req.headers['x-requested-with'] !== 'clinica-one' || !originOk;
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
  patientAdminRoutes(app);
  patientRoutes(app);
  appointmentRoutes(app);
  scheduleRoutes(app);
  noteRoutes(app);
  documentRoutes(app);
  dentalRoutes(app);
  dentalQuoteRoutes(app);
  financeRoutes(app);
  cashRoutes(app);
  inventoryRoutes(app);
  purchasingRoutes(app);
  crmRoutes(app);
  reportRoutes(app);
  paymentRoutes(app);
  payableRoutes(app);
  commissionRoutes(app);
  teamRoutes(app);
  communicationRoutes(app);
  telemetryRoutes(app);
  await webhookRoutes(app);

  const webDir = join(import.meta.dirname, '..', '..', 'web', 'dist');
  // Versão do frontend = hash do index.html (que referencia os arquivos com hash). O app aberto compara e se atualiza sozinho.
  const indexFile = join(webDir, 'index.html');
  const webVersion = existsSync(indexFile) ? createHash('sha256').update(readFileSync(indexFile)).digest('hex').slice(0, 16) : 'dev';
  app.get('/api/version', async () => ({ version: webVersion }));
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, {
      root: webDir,
      setHeaders: (res, path) => { if (path.endsWith('.html') || path.endsWith('manifest.webmanifest')) res.header('cache-control', 'no-cache'); },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').sendFile('index.html');
      return reply.status(404).send({ error: 'not_found', message: 'Não encontrado.', requestId: req.id });
    });
  }

  return app;
}
