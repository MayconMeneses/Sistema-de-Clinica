/**
 * Dados FICTÍCIOS de demonstração (somente desenvolvimento). Recusa rodar em produção.
 * Cria: 1 operador Master (com TOTP) e 2 clínicas demo com equipe, pacientes e consultas.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '../src/server/auth/password.js';
import { generateSecret, otpauthUri } from '../src/server/auth/totp.js';
import { decryptSecret, encryptSecret } from '../src/server/crypto.js';

if (process.env.NODE_ENV === 'production') throw new Error('Seed de demonstração não roda em produção.');

const platformUrl = process.env.DATABASE_URL_PLATFORM ?? 'postgres://clinica_platform:dev_platform_pw@127.0.0.1:5432/clinica_one';
const appUrl = process.env.DATABASE_URL_APP ?? 'postgres://clinica_app:dev_app_pw@127.0.0.1:5432/clinica_one';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo@12345';
const MASTER_EMAIL = 'master@demo.local';

const platform = new pg.Pool({ connectionString: platformUrl });
const app = new pg.Pool({ connectionString: appUrl });

async function inTenant<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

const hash = await hashPassword(DEMO_PASSWORD);

// Master
let secret: string;
const existing = await platform.query<{ totp_secret: string }>('SELECT totp_secret FROM platform_users WHERE email = $1', [MASTER_EMAIL]);
if (existing.rows[0]) secret = decryptSecret(existing.rows[0].totp_secret);
else {
  secret = generateSecret();
  await platform.query('INSERT INTO platform_users (email, name, password_hash, totp_secret) VALUES ($1,$2,$3,$4)', [MASTER_EMAIL, 'Operador Demo', hash, encryptSecret(secret)]);
}

async function createClinic(slug: string, name: string, plan: string) {
  const dir = await app.query<{ tenant_id: string }>('SELECT tenant_id FROM tenant_directory WHERE slug = $1', [slug]);
  if (dir.rows[0]) return { id: dir.rows[0].tenant_id, created: false };
  const id = randomUUID();
  await platform.query("INSERT INTO tenants (id, slug, name, plan_code, status) VALUES ($1,$2,$3,$4,'active')", [id, slug, name, plan]);
  await platform.query("INSERT INTO users (id, tenant_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5,'owner')", [randomUUID(), id, `dono@${slug}.demo`, 'Dono da Clínica', hash]);
  return { id, created: true };
}

const demo = await createClinic('demo', 'Clínica Demo Sorriso', 'completa');
const solo = await createClinic('solo-demo', 'Consultório Solo Demo', 'solo');

if (demo.created) {
  await inTenant(demo.id, async (c) => {
    const users: Record<string, string> = {};
    for (const [role, name] of [['admin', 'Ana Admin'], ['receptionist', 'Rita Recepção'], ['professional', 'Dr. Paulo Profissional'], ['professional', 'Dra. Carla Profissional'], ['finance', 'Fábio Financeiro']] as const) {
      const id = randomUUID();
      const slug = name.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
      await c.query('INSERT INTO users (id, tenant_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6)', [id, demo.id, `${slug}@demo.demo`, name, hash, role]);
      users[name] = id;
    }
    const patients: string[] = [];
    for (const [n, ph] of [['Maria Souza', '(11) 99999-0001'], ['João Pereira', '(11) 99999-0002'], ['Beatriz Lima', '(11) 99999-0003'], ['Carlos Mendes', '(11) 99999-0004']]) {
      const id = randomUUID();
      await c.query('INSERT INTO patients (id, tenant_id, name, phone) VALUES ($1,$2,$3,$4)', [id, demo.id, n, ph]);
      patients.push(id);
    }
    // 09:00 no horário de São Paulo (UTC-3), independentemente do fuso da máquina.
    const ymd = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const base = new Date(`${ymd}T09:00:00-03:00`);
    const pro = users['Dr. Paulo Profissional']!;
    for (let i = 0; i < patients.length; i++) {
      const s = new Date(base.getTime() + i * 3600_000);
      await c.query(
        `INSERT INTO appointments (tenant_id, patient_id, professional_id, starts_at, ends_at, service, price_cents) VALUES ($1,$2,$3,$4,$5,'Consulta',15000)`,
        [demo.id, patients[i], pro, s, new Date(s.getTime() + 3000_000)]);
    }
  });
}

// Complementos idempotentes (também valem para um banco de demonstração criado numa versão anterior).
await inTenant(demo.id, async (c) => {
  for (const [role, name] of [['unit_manager', 'Gabi Gerente'], ['stock', 'Edu Estoque'], ['marketing', 'Marta Marketing'], ['auditor', 'Aline Auditoria']] as const) {
    const slug = name.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
    await c.query('INSERT INTO users (id, tenant_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [randomUUID(), demo.id, `${slug}@demo.demo`, name, hash, role]);
  }
  const owner = (await c.query<{ id: string }>("SELECT id FROM users WHERE role = 'owner' LIMIT 1")).rows[0]!.id;
  // Unidade da demonstração: gerente e profissionais vinculados (o gerente só enxerga a agenda das suas unidades).
  let unit = (await c.query<{ id: string }>('SELECT id FROM units ORDER BY created_at LIMIT 1')).rows[0]?.id;
  if (!unit) unit = (await c.query<{ id: string }>("INSERT INTO units (tenant_id, name) VALUES ($1,'Unidade Centro') RETURNING id", [demo.id])).rows[0]!.id;
  await c.query(
    `INSERT INTO user_units (tenant_id, user_id, unit_id) SELECT $1, u.id, $2 FROM users u
      WHERE u.role IN ('unit_manager','professional') AND NOT EXISTS (SELECT 1 FROM user_units x WHERE x.user_id = u.id)`, [demo.id, unit]);
  if (!(await c.query('SELECT 1 FROM inventory_items LIMIT 1')).rowCount) {
    for (const [name, sku, unit, min, qty] of [['Luva de procedimento', 'LUV-M', 'cx', 5, 12], ['Resina composta A2', 'RES-A2', 'un', 3, 2], ['Anestésico lidocaína', 'ANE-01', 'un', 10, 25]] as const) {
      const id = randomUUID();
      await c.query('INSERT INTO inventory_items (id, tenant_id, name, sku, unit, min_quantity, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, demo.id, name, sku, unit, min, owner]);
      await c.query("INSERT INTO inventory_movements (tenant_id, item_id, kind, delta, reason, created_by) VALUES ($1,$2,'in',$3,'Estoque inicial',$4)", [demo.id, id, qty, owner]);
    }
  }
  if (!(await c.query('SELECT 1 FROM crm_leads LIMIT 1')).rowCount) {
    for (const [name, phone, source, interest, stage, days] of [['Fernanda Alves', '(11) 98888-1001', 'instagram', 'Clareamento', 'contacted', 1], ['Ricardo Gomes', '(11) 98888-1002', 'referral', 'Avaliação de implante', 'new', -1]] as const) {
      const id = randomUUID();
      await c.query(
        `INSERT INTO crm_leads (id, tenant_id, name, phone, source, interest, stage, next_contact_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,(now() AT TIME ZONE 'America/Sao_Paulo')::date + $8::int,$9)`,
        [id, demo.id, name, phone, source, interest, stage, days, owner]);
      await c.query("INSERT INTO crm_lead_events (tenant_id, lead_id, kind, to_stage, created_by) VALUES ($1,$2,'created','new',$3)", [demo.id, id, owner]);
    }
  }
});

console.log('\n=== DADOS DE DEMONSTRAÇÃO (fictícios; somente desenvolvimento) ===');
console.log(`Master   → e-mail: ${MASTER_EMAIL}  senha: ${DEMO_PASSWORD}  (MFA: código do app autenticador ou "npm run totp")`);
console.log(`           segredo TOTP: ${secret}`);
console.log(`           ${otpauthUri(secret, MASTER_EMAIL)}`);
console.log(`Clínica  → identificador: demo       (plano Completa)  senha de todos: ${DEMO_PASSWORD}`);
console.log('           usuários:');
const list = await inTenant(demo.id, (c) => c.query('SELECT email, role FROM users ORDER BY role, email'));
for (const u of list.rows) console.log(`             ${u.role.padEnd(13)} ${u.email}`);
console.log(`Clínica  → identificador: solo-demo  (plano Solo)      dono@solo-demo.demo`);
void solo;
await platform.end(); await app.end();
