import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { URL_APP, URL_OWNER, URL_PLATFORM } from './env.js';

export const appPool = new pg.Pool({ connectionString: URL_APP, max: 1 });
export const platformPool = new pg.Pool({ connectionString: URL_PLATFORM, max: 2 });
export const ownerPool = new pg.Pool({ connectionString: URL_OWNER, max: 2 });

export async function closePools() {
  await Promise.all([appPool.end(), platformPool.end(), ownerPool.end()]);
}

/** Cria tenant de teste via control plane (slug único por execução). */
export async function createTenant(label: string, plan = 'solo', status = 'active'): Promise<string> {
  const slug = `t-${label}-${randomBytes(4).toString('hex')}`;
  const r = await platformPool.query<{ id: string }>(
    'INSERT INTO tenants (slug, name, plan_code, status) VALUES ($1, $2, $3, $4) RETURNING id',
    [slug, `Clínica ${label}`, plan, status],
  );
  return r.rows[0]!.id;
}
