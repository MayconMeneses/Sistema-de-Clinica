import type pg from 'pg';
import { hashKey } from '../crypto.js';

/**
 * Limitador de falhas em janela fixa, guardado no PostgreSQL: vale com várias instâncias
 * e sobrevive a reinício. A chave é hasheada (sem IP/e-mail em claro).
 */
export class DbRateLimiter {
  constructor(private pool: pg.Pool, private max = 5, private windowMinutes = 15) {}

  async tooMany(key: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM rate_limits WHERE key_hash = $1 AND failures >= $2 AND window_start > now() - make_interval(mins => $3)`,
      [hashKey(key), this.max, this.windowMinutes]);
    return (r.rowCount ?? 0) > 0;
  }

  async record(key: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO rate_limits (key_hash, window_start, failures) VALUES ($1, now(), 1)
       ON CONFLICT (key_hash) DO UPDATE SET
         failures = CASE WHEN rate_limits.window_start < now() - make_interval(mins => $2) THEN 1 ELSE rate_limits.failures + 1 END,
         window_start = CASE WHEN rate_limits.window_start < now() - make_interval(mins => $2) THEN now() ELSE rate_limits.window_start END`,
      [hashKey(key), this.windowMinutes]);
    if (Math.random() < 0.01) {
      await this.pool.query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'").catch(() => undefined);
    }
  }

  async reset(key: string): Promise<void> {
    await this.pool.query('DELETE FROM rate_limits WHERE key_hash = $1', [hashKey(key)]);
  }
}
