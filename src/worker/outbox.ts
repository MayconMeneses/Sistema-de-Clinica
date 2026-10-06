import type pg from 'pg';
import { handleMessage, type OutboxRow } from '../modules/communications/handler.js';

/** Espera exponencial com jitter: ~30s, 1m, 2m, 4m… (teto 1h), ±50%. */
export function backoffMs(attempts: number, rnd = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
  return Math.round(base * (0.5 + rnd()));
}

export interface WorkerDeps { workerPool: pg.Pool; appPool: pg.Pool; batch?: number }

/**
 * Reivindica eventos vencidos com FOR UPDATE SKIP LOCKED (vários workers não pegam o mesmo evento),
 * processa e grava o resultado. Semântica: pelo menos uma vez; o id do evento é a chave de idempotência no provedor.
 * Evento "processing" com lock vencido (worker caiu) volta a ser elegível.
 */
export async function processOutbox(deps: WorkerDeps): Promise<{ claimed: number; sent: number; skipped: number; retried: number; dead: number }> {
  const stats = { claimed: 0, sent: 0, skipped: 0, retried: 0, dead: 0 };
  const claimed = await deps.workerPool.query<OutboxRow>(
    `UPDATE outbox_events o SET status = 'processing', attempts = o.attempts + 1, locked_until = now() + interval '2 minutes', updated_at = now()
      WHERE (o.tenant_id, o.id) IN (
        SELECT tenant_id, id FROM outbox_events
         WHERE (status IN ('pending','failed') AND next_attempt_at <= now()) OR (status = 'processing' AND locked_until < now())
         ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.tenant_id, o.payload, o.attempts, o.max_attempts`, [deps.batch ?? 10]);
  stats.claimed = claimed.rowCount ?? 0;

  for (const ev of claimed.rows) {
    const out = await handleMessage(deps.appPool, ev).catch((e) => ({ kind: 'retry' as const, code: 'unexpected', message: (e as Error).name }));
    if (out.kind === 'sent') {
      await deps.workerPool.query(
        `UPDATE outbox_events SET status='sent', delivery_status = COALESCE(delivery_status,'sent'), external_id=$3, last_error=NULL, processed_at=now(), locked_until=NULL, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [ev.tenant_id, ev.id, out.externalId]);
      stats.sent++;
    } else if (out.kind === 'skipped') {
      await deps.workerPool.query(
        `UPDATE outbox_events SET status='skipped', last_error=$3, processed_at=now(), locked_until=NULL, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [ev.tenant_id, ev.id, out.reason]);
      stats.skipped++;
    } else if (out.kind === 'dead' || ev.attempts >= ev.max_attempts) {
      await deps.workerPool.query(
        `UPDATE outbox_events SET status='dead', last_error=$3, processed_at=now(), locked_until=NULL, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [ev.tenant_id, ev.id, `${out.code}: ${out.message}`]);
      stats.dead++;
    } else {
      await deps.workerPool.query(
        `UPDATE outbox_events SET status='failed', last_error=$3, next_attempt_at = now() + ($4 || ' milliseconds')::interval, locked_until=NULL, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [ev.tenant_id, ev.id, `${out.code}: ${out.message}`, String(backoffMs(ev.attempts))]);
      stats.retried++;
    }
  }
  return stats;
}
