import type pg from 'pg';
import { decryptSecret } from '../crypto.js';
import { matchTotpStep } from './totp.js';

/**
 * Valida um código TOTP e o "consome": cada passo de 30s só vale uma vez, o que impede
 * reutilizar um código capturado (replay). Retorna true somente se o código é válido e inédito.
 */
export async function consumeTotp(
  db: Pick<pg.PoolClient, 'query'> | pg.Pool,
  table: 'users' | 'platform_users',
  id: string,
  storedSecret: string,
  code: string,
): Promise<boolean> {
  const step = matchTotpStep(decryptSecret(storedSecret), code);
  if (step === null) return false;
  const r = await db.query(
    `UPDATE ${table} SET totp_last_step = $1 WHERE id = $2 AND (totp_last_step IS NULL OR totp_last_step < $1)`,
    [step, id]);
  return r.rowCount === 1;
}
