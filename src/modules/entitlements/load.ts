import type pg from 'pg';
import { resolveEntitlements, type CapabilityDef, type TenantStatus } from './resolve.js';

/** Deve rodar dentro de withTenant(): o RLS limita tenants/overrides ao tenant do contexto. */
export async function loadEntitlements(client: pg.PoolClient): Promise<Set<string>> {
  const tenant = await client.query<{ status: TenantStatus; plan_code: string }>(
    'SELECT status, plan_code FROM tenants',
  );
  const row = tenant.rows[0];
  if (!row || tenant.rows.length !== 1) return new Set(); // sem contexto => negar
  // Sequencial: uma conexão não executa queries em paralelo.
  const plan = await client.query<{ capability_code: string }>('SELECT capability_code FROM plan_capabilities WHERE plan_code = $1', [row.plan_code]);
  const overrides = await client.query<{ capability_code: string; mode: 'grant' | 'block' }>('SELECT capability_code, mode FROM tenant_entitlement_overrides');
  const catalog = await client.query<{ code: string; globally_available: boolean; depends_on: string[] }>('SELECT code, globally_available, depends_on FROM capabilities');
  return resolveEntitlements({
    tenantStatus: row.status,
    planCapabilities: plan.rows.map((r) => r.capability_code),
    overrides: overrides.rows.map((r) => ({ capability: r.capability_code, mode: r.mode })),
    catalog: catalog.rows.map((r): CapabilityDef => ({ code: r.code, globallyAvailable: r.globally_available, dependsOn: r.depends_on })),
  });
}
