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
      if (o.dead) {
        // Diz QUAL clínica tem mensagens paradas (o worker enxerga só o diretório slug→clínica, nunca dados dela).
        const who = await workerPool.query<{ slug: string; n: number }>(`SELECT d.slug, count(*)::int AS n FROM outbox_events e JOIN tenant_directory d ON d.tenant_id = e.tenant_id WHERE e.status = 'dead' GROUP BY d.slug ORDER BY n DESC LIMIT 5`).catch(() => ({ rows: [] }));
        const names = who.rows.map((r) => `${r.slug} (${r.n})`).join(', ');
        notify({ severity: 'warning', component: 'mensageria', title: 'Mensagens esgotaram as tentativas', detail: `${o.dead} nova(s). Clínicas com mensagens paradas: ${names || '—'}. O aviso ao paciente não saiu.`, where: 'Painel Master → Integrações → Falhas definitivas', fingerprint: 'outbox-dead' });
      }
      if (r.dead) notify({ severity: 'warning', component: 'pagamentos', title: 'Notificações de gateway sem correspondência', detail: `${r.dead} webhook(s) não puderam ser conciliados.`, where: 'Painel Master → Integrações → Recibos de webhook', fingerprint: 'receipts-dead' });
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
