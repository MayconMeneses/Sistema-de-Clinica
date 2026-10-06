import type pg from 'pg';

const RANK = `CASE $1::text WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END`;

/**
 * Aplica eventos de entrega (webhooks já validados e normalizados) às mensagens.
 * - Fora de ordem: "delivered" pode chegar antes de o envio ser gravado → o recibo fica aberto e é tentado de novo.
 * - Nunca regride: "read" não volta para "delivered"; "failed" não sobrescreve entregue/lido.
 * - Sem correspondência após 5 tentativas → dead-letter (a plataforma pode recolocar na fila).
 */
export async function processReceipts(workerPool: pg.Pool, limit = 50): Promise<{ processed: number; waiting: number; dead: number }> {
  const out = { processed: 0, waiting: 0, dead: 0 };
  const client = await workerPool.connect();
  try {
    await client.query('BEGIN');
    const open = await client.query<{ id: string; external_message_id: string; event_status: string; attempts: number }>(
      `SELECT id, external_message_id, event_status, attempts FROM webhook_receipts WHERE status = 'received' ORDER BY received_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    for (const r of open.rows) {
      const upd = await client.query(
        `UPDATE outbox_events SET delivery_status = $1, updated_at = now()
          WHERE external_id = $2
            AND CASE WHEN $1 = 'failed' THEN COALESCE(delivery_status,'sent') NOT IN ('delivered','read')
                     ELSE (${RANK.replace('$1::text', 'COALESCE(delivery_status,\'\')')}) < (${RANK}) END`, [r.event_status, r.external_message_id]);
      const exists = upd.rowCount ? true : (await client.query('SELECT 1 FROM outbox_events WHERE external_id = $1', [r.external_message_id])).rowCount! > 0;
      if (exists) {
        await client.query(`UPDATE webhook_receipts SET status='processed', processed_at=now(), attempts=attempts+1 WHERE id=$1`, [r.id]);
        out.processed++;
      } else if (r.attempts + 1 >= 5) {
        await client.query(`UPDATE webhook_receipts SET status='dead', attempts=attempts+1 WHERE id=$1`, [r.id]);
        out.dead++;
      } else {
        await client.query(`UPDATE webhook_receipts SET attempts=attempts+1 WHERE id=$1`, [r.id]);
        out.waiting++;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return out;
}
