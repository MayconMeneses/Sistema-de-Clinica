import pg from 'pg';
import { migrate } from '../scripts/migrate.js';
import { URL_OWNER } from './env.js';

const clearRateLimits = async () => {
  const pool = new pg.Pool({ connectionString: URL_OWNER, max: 1 });
  await pool.query('DELETE FROM rate_limits').catch(() => undefined);
  await pool.end();
};

export default async function setup() {
  await migrate(URL_OWNER);
  await clearRateLimits();
  // Os testes saem todos do mesmo IP e erram logins de propósito: ao terminar, zera os contadores para não barrar o E2E que roda depois no mesmo banco (CI).
  return clearRateLimits;
}
