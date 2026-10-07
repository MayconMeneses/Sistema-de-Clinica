import type { Tx } from '../../server/http.js';

/** Próximo número de recibo da clínica (sequencial, sem buracos: se a transação falhar, o número volta junto). */
export async function nextReceiptNumber(tx: Tx, tenantId: string): Promise<number> {
  const c = await tx.query<{ n: string }>(
    `INSERT INTO receipt_counters (tenant_id, last_number) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET last_number = receipt_counters.last_number + 1 RETURNING last_number::text AS n`, [tenantId]);
  return Number(c.rows[0]!.n);
}
