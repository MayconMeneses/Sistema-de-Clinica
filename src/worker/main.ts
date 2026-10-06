import { appPool, workerPool } from '../server/db.js';
import { processOutbox } from './outbox.js';
import { processReceipts } from './receipts.js';

/** Laço do worker. Em produção rode como processo separado (`npm run worker`); em dev roda junto do servidor. */
export function startWorker(log: (msg: string, extra?: object) => void = () => undefined, intervalMs = 5000) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const o = await processOutbox({ workerPool, appPool });
      const r = await processReceipts(workerPool);
      if (o.claimed || r.processed || r.dead) log('worker', { outbox: o, receipts: r });
    } catch (e) {
      log('worker_error', { name: (e as Error).name });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 1000);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker((m, x) => console.log(m, JSON.stringify(x ?? {})));
  console.log('Worker iniciado');
}
