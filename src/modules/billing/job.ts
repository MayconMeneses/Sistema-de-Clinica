import type pg from 'pg';
import { notify, reportError } from '../../ops/alerts.js';
import { currentMonthStart, evaluateBilling, generateInvoices, todayBr } from './billing.js';

/** Uma rodada: gera as faturas do mês (idempotente) e aplica carência/suspensão/reativação, registrando na auditoria da plataforma. */
export async function billingTick(pool: pg.Pool, now = new Date()) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const gen = await generateInvoices(db, currentMonthStart(now));
    const changes = await evaluateBilling(db, todayBr(now));
    for (const ch of changes) {
      await db.query(`INSERT INTO platform_audit_events (operator_id, action, tenant_id, justification, metadata) VALUES ('sistema',$1,$2,'Rotina automática de cobrança',$3)`,
        [`tenant.billing_${ch.action}`, ch.tenantId, JSON.stringify({ daysOverdue: ch.daysOverdue })]);
    }
    await db.query('COMMIT');
    for (const ch of changes) notify({ severity: ch.action === 'suspended' ? 'warning' : 'info', component: 'clientes', title: ch.action === 'suspended' ? 'Cliente suspenso por inadimplência' : 'Cliente reativado após pagamento', detail: `${ch.daysOverdue} dia(s) de atraso`, tenant: { id: ch.tenantId, name: ch.name }, fingerprint: `cobranca|${ch.tenantId}|${ch.action}` });
    return { created: gen.created, changes: changes.length };
  } catch (e) { await db.query('ROLLBACK').catch(() => undefined); throw e; } finally { db.release(); }
}

/** Opt-in (BILLING_AUTO=1): roda na subida e a cada hora. Sem a variável, a cobrança é só manual pelo painel da plataforma. */
export function startBillingJob(pool: pg.Pool, log: (msg: string, extra?: object) => void = () => undefined) {
  if (process.env.BILLING_AUTO !== '1') return () => undefined;
  const run = () => billingTick(pool).then((r) => { if (r.created || r.changes) log('billing', r); }, (e) => reportError(e, { component: 'clientes', title: 'Rotina de cobrança falhou', fingerprint: 'billing-job' }));
  const first = setTimeout(run, 5000);
  const timer = setInterval(run, 3_600_000);
  return () => { clearTimeout(first); clearInterval(timer); };
}
