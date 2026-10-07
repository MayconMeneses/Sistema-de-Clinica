import { appPool, workerPool } from '../server/db.js';
import { appVersion, notify, reportError, initAlerts, installProcessHandlers } from '../ops/alerts.js';
import { startTelegramBot } from '../ops/telegram-bot.js';
import { processOutbox } from './outbox.js';
import { processReceipts } from './receipts.js';

/** Laço do worker. Em produção rode como processo separado (`npm run worker`); em dev roda junto do servidor. */
export function startWorker(log: (msg: string, extra?: object) => void = () => undefined, intervalMs = 5000, version = appVersion()) {
  initAlerts(workerPool);
  const stopBot = startTelegramBot(workerPool, version, log);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let failures = 0;
  let dbDown = false;
  let lastHealth = 0;
  // Verificação do banco a cada minuto: avisa a queda e também a recuperação.
  const checkHealth = async () => {
    if (Date.now() - lastHealth < 60_000) return;
    lastHealth = Date.now();
    try {
      await workerPool.query('SELECT 1');
      if (dbDown) { dbDown = false; notify({ severity: 'info', component: 'banco', title: 'Banco de dados voltou a responder', fingerprint: 'db-up' }); }
    } catch (e) {
      if (!dbDown) { dbDown = true; reportError(e, { component: 'banco', title: 'Banco de dados não responde', fingerprint: 'db-down' }); }
    }
  };
  const tick = async () => {
    if (stopped) return;
    try {
      const o = await processOutbox({ workerPool, appPool });
      const r = await processReceipts(workerPool);
      if (o.claimed || r.processed || r.dead) log('worker', { outbox: o, receipts: r });
      if (o.dead) notify({ severity: 'warning', component: 'mensageria', title: 'Mensagens esgotaram as tentativas', detail: `${o.dead} mensagem(ns) foram para a fila de falhas (aviso aos pacientes não saiu). Veja o Painel Master.`, fingerprint: 'outbox-dead' });
      if (r.dead) notify({ severity: 'warning', component: 'pagamentos', title: 'Notificações de gateway sem correspondência', detail: `${r.dead} webhook(s) não puderam ser conciliados.`, fingerprint: 'receipts-dead' });
      failures = 0;
    } catch (e) {
      log('worker_error', { name: (e as Error).name });
      if (++failures >= 3) reportError(e, { component: 'worker', title: 'Worker falhando repetidamente', fingerprint: 'worker-loop' });
    }
    await checkHealth();
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 1000);
  return () => { stopped = true; stopBot(); if (timer) clearTimeout(timer); };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  installProcessHandlers('worker');
  startWorker((m, x) => console.log(m, JSON.stringify(x ?? {})));
  console.log('Worker iniciado');
}
