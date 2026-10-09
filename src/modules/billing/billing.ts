import type pg from 'pg';

export type DueState = 'ok' | 'late' | 'suspend';

/** Preço mensal efetivo: o combinado com o cliente vale sobre o do plano. Sem preço = sem cobrança. */
export function effectivePrice(planCents: number | null, overrideCents: number | null): number | null {
  const p = overrideCents ?? planCents;
  return p && p > 0 ? p : null;
}

/** Vencimento do mês `period` (AAAA-MM-01) no dia `dueDay` (1–28, nunca cai em mês sem o dia). */
export function dueDateFor(period: string, dueDay: number): string {
  return `${period.slice(0, 7)}-${String(dueDay).padStart(2, '0')}`;
}

const dayNum = (ymd: string) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);

/** Situação pela fatura aberta mais antiga: até `graceDays` de atraso só avisa; passou disso, suspende. */
export function dueState(today: string, openDueDates: string[], graceDays: number): { state: DueState; daysOverdue: number } {
  if (!openDueDates.length) return { state: 'ok', daysOverdue: 0 };
  const oldest = openDueDates.reduce((a, b) => (a < b ? a : b));
  const days = Math.max(0, dayNum(today) - dayNum(oldest));
  if (days === 0) return { state: 'ok', daysOverdue: 0 };
  return { state: days > graceDays ? 'suspend' : 'late', daysOverdue: days };
}

export function currentMonthStart(now = new Date()): string {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return `${s.slice(0, 7)}-01`;
}
export const todayBr = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);

/** Gera as faturas do mês para clientes ativos com preço. Idempotente (uma por clínica e mês). */
export async function generateInvoices(db: pg.Pool | pg.PoolClient, period: string): Promise<{ created: number; skippedNoPrice: number }> {
  const t = await db.query<{ id: string; plan_code: string; price: number | null; ovr: number | null; due_day: number | null }>(
    `SELECT t.id, t.plan_code, p.price_cents AS price, b.price_override_cents AS ovr, b.due_day
       FROM tenants t JOIN plans p ON p.code = t.plan_code LEFT JOIN tenant_billing b ON b.tenant_id = t.id
      WHERE t.status = 'active' OR b.suspended_by_billing`);
  let created = 0, skippedNoPrice = 0;
  for (const r of t.rows) {
    const price = effectivePrice(r.price, r.ovr);
    if (!price) { skippedNoPrice++; continue; }
    const ins = await db.query(
      `INSERT INTO platform_invoices (tenant_id, period, plan_code, amount_cents, due_date) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, period) DO NOTHING`,
      [r.id, period, r.plan_code, price, dueDateFor(period, r.due_day ?? 10)]);
    created += ins.rowCount ?? 0;
  }
  return { created, skippedNoPrice };
}

export interface BillingChange { tenantId: string; slug: string; name: string; action: 'suspended' | 'reactivated'; daysOverdue: number }

/** Suspende quem passou da carência e reativa quem regularizou (só se a suspensão foi por cobrança). */
export async function evaluateBilling(db: pg.Pool | pg.PoolClient, today: string): Promise<BillingChange[]> {
  const rows = await db.query<{ id: string; slug: string; name: string; status: string; grace: number; by_billing: boolean; dues: string[] | null }>(
    `SELECT t.id, t.slug, t.name, t.status, COALESCE(b.grace_days, 7)::int AS grace, COALESCE(b.suspended_by_billing, false) AS by_billing,
            (SELECT array_agg(i.due_date::text) FROM platform_invoices i WHERE i.tenant_id = t.id AND i.status = 'open') AS dues
       FROM tenants t LEFT JOIN tenant_billing b ON b.tenant_id = t.id
      WHERE t.status IN ('active','suspended')`);
  const changes: BillingChange[] = [];
  for (const r of rows.rows) {
    const s = dueState(today, r.dues ?? [], r.grace);
    if (r.status === 'active' && s.state === 'suspend') {
      await db.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [r.id]);
      await db.query(`INSERT INTO tenant_billing (tenant_id, suspended_by_billing) VALUES ($1, true) ON CONFLICT (tenant_id) DO UPDATE SET suspended_by_billing = true, updated_at = now()`, [r.id]);
      changes.push({ tenantId: r.id, slug: r.slug, name: r.name, action: 'suspended', daysOverdue: s.daysOverdue });
    } else if (r.status === 'suspended' && r.by_billing && s.state !== 'suspend') {
      await db.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [r.id]);
      await db.query(`UPDATE tenant_billing SET suspended_by_billing = false, updated_at = now() WHERE tenant_id = $1`, [r.id]);
      changes.push({ tenantId: r.id, slug: r.slug, name: r.name, action: 'reactivated', daysOverdue: s.daysOverdue });
    }
  }
  return changes;
}

/** Situação de cobrança vista pela própria clínica (rodar dentro de withTenant: o RLS limita à clínica do contexto). */
export async function clinicBillingStatus(tx: pg.PoolClient, today = todayBr()): Promise<{ state: DueState; daysOverdue: number; graceDays: number; graceLeft: number | null }> {
  const g = await tx.query<{ grace: number }>('SELECT COALESCE((SELECT grace_days FROM tenant_billing LIMIT 1), 7)::int AS grace');
  const d = await tx.query<{ due: string }>(`SELECT due_date::text AS due FROM platform_invoices WHERE status = 'open'`);
  const grace = g.rows[0]!.grace;
  const s = dueState(today, d.rows.map((r) => r.due), grace);
  return { ...s, graceDays: grace, graceLeft: s.state === 'ok' ? null : Math.max(0, grace - s.daysOverdue) };
}
