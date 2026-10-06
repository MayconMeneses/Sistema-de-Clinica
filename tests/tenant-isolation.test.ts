import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { loadEntitlements } from '../src/modules/entitlements/load.js';
import { appPool, closePools, createTenant, ownerPool, platformPool } from './helpers.js';

let tenantA: string;
let tenantB: string;
let unitA: string;
let unitB: string;

beforeAll(async () => {
  tenantA = await createTenant('a', 'solo');
  tenantB = await createTenant('b', 'completa');
  unitA = (await withTenant(appPool, tenantA, (c) =>
    c.query<{ id: string }>("INSERT INTO units (tenant_id, name) VALUES ($1, 'Unidade A') RETURNING id", [tenantA]))).rows[0]!.id;
  unitB = (await withTenant(appPool, tenantB, (c) =>
    c.query<{ id: string }>("INSERT INTO units (tenant_id, name) VALUES ($1, 'Unidade B') RETURNING id", [tenantB]))).rows[0]!.id;
});

afterAll(closePools);

describe('RLS — isolamento entre tenants (dados)', () => {
  it('Tenant A lê somente os próprios registros', async () => {
    const r = await withTenant(appPool, tenantA, (c) => c.query('SELECT id, tenant_id FROM units'));
    expect(r.rows.map((x) => x.id)).toEqual([unitA]);
    expect(r.rows.every((x) => x.tenant_id === tenantA)).toBe(true);
  });

  it('Tenant A não lê registro de B nem por id exato (IDOR)', async () => {
    const r = await withTenant(appPool, tenantA, (c) => c.query('SELECT * FROM units WHERE id = $1', [unitB]));
    expect(r.rowCount).toBe(0);
  });

  it('Tenant A não altera registro de B', async () => {
    const r = await withTenant(appPool, tenantA, (c) => c.query("UPDATE units SET name = 'invadido' WHERE id = $1", [unitB]));
    expect(r.rowCount).toBe(0);
    const check = await withTenant(appPool, tenantB, (c) => c.query('SELECT name FROM units WHERE id = $1', [unitB]));
    expect(check.rows[0]!.name).toBe('Unidade B');
  });

  it('Tenant A não exclui registro de B', async () => {
    const r = await withTenant(appPool, tenantA, (c) => c.query('DELETE FROM units WHERE id = $1', [unitB]));
    expect(r.rowCount).toBe(0);
    const check = await withTenant(appPool, tenantB, (c) => c.query('SELECT 1 FROM units WHERE id = $1', [unitB]));
    expect(check.rowCount).toBe(1);
  });

  it('Tenant A não insere registro rotulado como tenant B', async () => {
    await expect(
      withTenant(appPool, tenantA, (c) => c.query("INSERT INTO units (tenant_id, name) VALUES ($1, 'x')", [tenantB])),
    ).rejects.toThrow(/row-level security/);
  });

  it('Tenant A não move um registro seu para o tenant B (UPDATE tenant_id)', async () => {
    await expect(
      withTenant(appPool, tenantA, (c) => c.query('UPDATE units SET tenant_id = $1 WHERE id = $2', [tenantB, unitA])),
    ).rejects.toThrow(/row-level security/);
  });

  it('sem contexto de tenant: nenhuma linha visível e escrita negada (deny by default)', async () => {
    const r = await appPool.query('SELECT * FROM units');
    expect(r.rowCount).toBe(0);
    await expect(appPool.query("INSERT INTO units (tenant_id, name) VALUES ($1, 'x')", [tenantA])).rejects.toThrow(/row-level security/);
  });

  it('contexto não vaza entre usos da mesma conexão (pool de 1 conexão)', async () => {
    await withTenant(appPool, tenantA, (c) => c.query('SELECT 1'));
    const r = await appPool.query('SELECT * FROM units');
    expect(r.rowCount).toBe(0);
  });

  it('tenantId malformado (tentativa de injeção) é rejeitado antes de tocar o banco', async () => {
    await expect(withTenant(appPool, "x'; DROP TABLE units; --", async () => 1)).rejects.toThrow('tenantId inválido');
  });

  it('FK composta impede recurso do tenant A apontar para unidade do tenant B', async () => {
    await expect(
      withTenant(appPool, tenantA, (c) =>
        c.query("INSERT INTO resources (tenant_id, unit_id, name, kind) VALUES ($1, $2, 'sala', 'room')", [tenantA, unitB])),
    ).rejects.toThrow(/foreign key/);
  });

  it('Tenant A não vê tenants nem overrides de B', async () => {
    await platformPool.query(
      "INSERT INTO tenant_entitlement_overrides (tenant_id, capability_code, mode, reason) VALUES ($1, 'analytics.bi', 'grant', 'teste')",
      [tenantB],
    );
    const t = await withTenant(appPool, tenantA, (c) => c.query('SELECT id FROM tenants'));
    expect(t.rows.map((x) => x.id)).toEqual([tenantA]);
    const o = await withTenant(appPool, tenantA, (c) => c.query('SELECT * FROM tenant_entitlement_overrides'));
    expect(o.rowCount).toBe(0);
  });
});

describe('privilégios e papéis', () => {
  it('nenhum papel da aplicação é superuser nem BYPASSRLS', async () => {
    const r = await ownerPool.query(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('clinica_app','clinica_platform','clinica_owner')",
    );
    expect(r.rowCount).toBe(3);
    for (const row of r.rows) {
      expect(row.rolsuper).toBe(false);
      expect(row.rolbypassrls).toBe(false);
    }
  });

  it('todas as tabelas tenant-aware têm RLS habilitado e forçado', async () => {
    const r = await ownerPool.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relname IN ('tenants','tenant_entitlement_overrides','units','resources','audit_events')`,
    );
    expect(r.rowCount).toBe(5);
    for (const row of r.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });

  it('toda tabela com coluna tenant_id possui RLS (guarda contra tabela nova sem política)', async () => {
    const r = await ownerPool.query(
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
    );
    // Exceções conscientes: auditoria da plataforma (sem acesso do runtime) e diretório slug->tenant (só resolve login, sem dados).
    expect(r.rows.map((x) => x.relname).sort()).toEqual(['platform_audit_events', 'tenant_directory']);
  });

  it('runtime da clínica não altera tenants, planos nem catálogo', async () => {
    await expect(withTenant(appPool, tenantA, (c) => c.query("UPDATE tenants SET plan_code = 'enterprise'"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(appPool, tenantA, (c) => c.query("INSERT INTO plan_capabilities VALUES ('solo','analytics.bi')"))).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(appPool, tenantA, (c) => c.query("INSERT INTO tenant_entitlement_overrides (tenant_id, capability_code, mode, reason) VALUES ($1,'analytics.bi','grant','x')", [tenantA])),
    ).rejects.toThrow(/permission denied/);
  });

  it('runtime da clínica não lê a auditoria da plataforma', async () => {
    await expect(withTenant(appPool, tenantA, (c) => c.query('SELECT * FROM platform_audit_events'))).rejects.toThrow(/permission denied/);
  });
});

describe('auditoria append-only', () => {
  it('tenant insere e lê só a própria auditoria; não escreve em nome de outro tenant', async () => {
    await withTenant(appPool, tenantA, (c) => c.query("INSERT INTO audit_events (tenant_id, action, entity_type) VALUES ($1, 'unit.create', 'unit')", [tenantA]));
    await withTenant(appPool, tenantB, (c) => c.query("INSERT INTO audit_events (tenant_id, action, entity_type) VALUES ($1, 'unit.create', 'unit')", [tenantB]));
    const a = await withTenant(appPool, tenantA, (c) => c.query('SELECT tenant_id FROM audit_events'));
    expect(a.rowCount).toBeGreaterThan(0);
    expect(a.rows.every((x) => x.tenant_id === tenantA)).toBe(true);
    await expect(
      withTenant(appPool, tenantA, (c) => c.query("INSERT INTO audit_events (tenant_id, action, entity_type) VALUES ($1, 'forjado', 'unit')", [tenantB])),
    ).rejects.toThrow(/row-level security/);
  });

  it('UPDATE e DELETE falham para o runtime (sem privilégio)', async () => {
    await expect(withTenant(appPool, tenantA, (c) => c.query("UPDATE audit_events SET action = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(appPool, tenantA, (c) => c.query('DELETE FROM audit_events'))).rejects.toThrow(/permission denied/);
  });

  it('owner sob FORCE RLS não enxerga nem altera linhas de auditoria', async () => {
    const r = await ownerPool.query("UPDATE audit_events SET action = 'x'");
    expect(r.rowCount).toBe(0);
  });

  it('UPDATE, DELETE e TRUNCATE falham até para o owner sem RLS (trigger)', async () => {
    // Desliga FORCE RLS só dentro de uma transação revertida, para exercitar o trigger com linhas visíveis.
    const client = await ownerPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY');
      await expect(client.query("UPDATE audit_events SET action = 'x'")).rejects.toThrow(/append-only/);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY');
      await expect(client.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    await expect(ownerPool.query('TRUNCATE audit_events')).rejects.toThrow(/append-only/);
  });

  it('auditoria da plataforma exige justificativa e é append-only', async () => {
    await expect(
      platformPool.query("INSERT INTO platform_audit_events (operator_id, action, justification) VALUES ('op1','tenant.suspend','  ')"),
    ).rejects.toThrow(/check/);
    await platformPool.query("INSERT INTO platform_audit_events (operator_id, action, tenant_id, justification) VALUES ('op1','tenant.suspend',$1,'inadimplência')", [tenantA]);
    await expect(platformPool.query("UPDATE platform_audit_events SET action = 'x'")).rejects.toThrow(/permission denied/);
  });
});

describe('capabilities e entitlements no banco', () => {
  it('override não habilita capability globalmente indisponível (tiss.billing)', async () => {
    await expect(
      platformPool.query("INSERT INTO tenant_entitlement_overrides (tenant_id, capability_code, mode, reason) VALUES ($1,'tiss.billing','grant','tentativa')", [tenantB]),
    ).rejects.toThrow(/globalmente indisponível/);
  });

  it('plano não inclui capability globalmente indisponível', async () => {
    await expect(platformPool.query("INSERT INTO plan_capabilities VALUES ('enterprise','tiss.billing')")).rejects.toThrow(/globalmente indisponível/);
  });

  it('entitlement efetivo por tenant respeita o plano de cada um', async () => {
    const a = await withTenant(appPool, tenantA, loadEntitlements);
    const b = await withTenant(appPool, tenantB, loadEntitlements);
    expect(a.has('finance.basic')).toBe(true);
    expect(a.has('dental.odontogram')).toBe(false); // solo
    expect(b.has('dental.odontogram')).toBe(true); // completa
    expect(a.has('tiss.billing') || b.has('tiss.billing')).toBe(false);
  });

  it('sem contexto de tenant: entitlements vazios', async () => {
    const client = await appPool.connect();
    try {
      expect((await loadEntitlements(client)).size).toBe(0);
    } finally {
      client.release();
    }
  });

  it('suspensão remove acesso imediatamente, mesmo com plano contratado', async () => {
    const t = await createTenant('susp', 'completa');
    expect((await withTenant(appPool, t, loadEntitlements)).size).toBeGreaterThan(0);
    await platformPool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [t]);
    expect((await withTenant(appPool, t, loadEntitlements)).size).toBe(0);
  });

  it('bloqueio do Master e downgrade removem capability e dependentes', async () => {
    const t = await createTenant('down', 'completa');
    await platformPool.query("INSERT INTO tenant_entitlement_overrides (tenant_id, capability_code, mode, reason) VALUES ($1,'clinical.record','block','teste')", [t]);
    const e = await withTenant(appPool, t, loadEntitlements);
    expect(e.has('clinical.record')).toBe(false);
    expect(e.has('dental.odontogram')).toBe(false);
    await platformPool.query("UPDATE tenants SET plan_code = 'solo' WHERE id = $1", [t]);
    expect((await withTenant(appPool, t, loadEntitlements)).has('care.telehealth')).toBe(false);
  });
});
