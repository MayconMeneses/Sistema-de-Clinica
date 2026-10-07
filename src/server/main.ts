import { startWorker } from '../worker/main.js';
import { installProcessHandlers } from '../ops/alerts.js';
import { buildApp } from './app.js';
import { config } from './config.js';
import { appPool, platformPool, workerPool } from './db.js';

installProcessHandlers('api');
const app = await buildApp({ logger: true });
await app.listen({ port: config.port, host: config.host });

// Em desenvolvimento o worker roda junto do servidor; em produção use `npm run worker` (WORKER_INLINE=0).
const inline = process.env.WORKER_INLINE === '1' || (!config.isProd && process.env.WORKER_INLINE !== '0');
const stopWorker = inline ? startWorker((msg, extra) => app.log.info(extra ?? {}, msg)) : () => undefined;

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopWorker();
    void app.close().then(() => Promise.all([appPool.end(), platformPool.end(), workerPool.end()])).then(() => process.exit(0));
  });
}
