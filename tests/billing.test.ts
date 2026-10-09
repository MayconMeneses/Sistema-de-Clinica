import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dueDateFor, dueState, effectivePrice } from '../src/modules/billing/billing.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { Client, master, tenant, state, PW } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { process.env.DEMO_SKIP_MASTER_MFA = '1'; app = await buildApp(); state.app = app; });   // muitos códigos TOTP numa só sessão; a exigência é testada à parte
afterAll(async () => { delete process.env.DEMO_SKIP_MASTER_MFA; await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

describe('regras de cobrança', () => {
  it('preço efetivo, vencimento e carência', () => {
    expect(effectivePrice(10000, null)).toBe(10000);
    expect(effectivePrice(10000, 8000)).toBe(8000);
    expect(effectivePrice(null, null)).toBeNull();
    expect(effectivePrice(10000, 0)).toBeNull();                       // combinado grátis
    expect(dueDateFor('2026-03-01', 5)).toBe('2026-03-05');
    expect(dueState('2026-03-05', [], 7)).toEqual({ state: 'ok', daysOverdue: 0 });
    expect(dueState('2026-03-05', ['2026-03-05'], 7)).toEqual({ state: 'ok', daysOverdue: 0 });          // vence hoje: ainda em dia
    expect(dueState('2026-03-12', ['2026-03-05'], 7)).toEqual({ state: 'late', daysOverdue: 7 });        // dentro da carência
    expect(dueState('2026-03-13', ['2026-03-05'], 7)).toEqual({ state: 'suspend', daysOverdue: 8 });
    expect(dueState('2026-03-13', ['2026-03-12', '2026-03-05'], 7).state).toBe('suspend');               // vale a mais antiga
    expect(dueState('2026-03-06', ['2026-03-05'], 0).state).toBe('suspend');                              // sem carência
  });
});

const J = 'teste de cobrança';
async function priced(label: string) {
  const t = await tenant(label, 'solo');
  const m = await master();
  return { t, m };
}

describe('ações críticas pedem MFA', () => {
  it('alterar preço/limites e rodar a avaliação sem código recusa', async () => {
    const m = await master();
    delete process.env.DEMO_SKIP_MASTER_MFA;
    try {
      expect((await m.c.patch('/api/master/plans/solo', { priceCents: 1, maxUsers: null, maxPatients: null, maxStorageMb: null, justification: J })).statusCode).toBe(403);
      expect((await m.c.post('/api/master/billing/run', { justification: J })).statusCode).toBe(403);
    } finally { process.env.DEMO_SKIP_MASTER_MFA = '1'; }
    const plan = (await m.c.get('/api/master/billing')).json().plans.find((p: { code: string }) => p.code === 'solo');
    expect(plan.priceCents).toBeNull();
  });
});

describe('faturas, inadimplência e limites', () => {
  it('gera fatura idempotente só para quem tem preço; pagar reativa; fatura paga é definitiva', async () => {
    const { t, m } = await priced('bill');
    const pr = (await m.c.get('/api/master/billing')).json();
    expect(pr.plans.find((p: { code: string }) => p.code === 'solo').priceCents).toBeNull();
    // sem preço: nada é cobrado
    const g0 = (await m.c.post('/api/master/billing/generate', { justification: J })).json();
    expect(g0.skippedNoPrice).toBeGreaterThan(0);
    expect((await m.c.get('/api/master/billing')).json().invoices.filter((i: { tenantId: string }) => i.tenantId === t.id)).toHaveLength(0);
    // preço combinado só com este cliente (não mexe no plano para não afetar outros testes)
    expect((await m.c.patch(`/api/master/tenants/${t.id}/billing`, { overrideCents: 15000, dueDay: 5, graceDays: 3, justification: J })).statusCode).toBe(200);
    const g1 = (await m.c.post('/api/master/billing/generate', { period: '2026-01', justification: J })).json();
    expect(g1.created).toBeGreaterThanOrEqual(1);
    expect((await m.c.post('/api/master/billing/generate', { period: '2026-01', justification: J })).json().created).toBe(0);   // idempotente
    expect((await m.c.post('/api/master/billing/generate', { period: '2026-13', justification: J })).statusCode).toBe(400);
    const inv = (await m.c.get('/api/master/billing')).json().invoices.find((i: { tenantId: string }) => i.tenantId === t.id);
    expect(inv).toMatchObject({ amountCents: 15000, dueDate: '2026-01-05', status: 'open' });

    // atrasada há meses → a avaliação suspende; a clínica não entra mais
    const run = (await m.c.post('/api/master/billing/run', { code: m.code(), justification: J })).json();
    expect(run.changes.some((x: { name: string; action: string }) => x.name === 'Clínica bill' && x.action === 'suspended')).toBe(true);
    expect((await t.owner.get('/api/me')).statusCode).toBe(403);
    // pagar reativa na hora, só porque a suspensão foi por cobrança
    expect((await m.c.post(`/api/master/invoices/${inv.id}/pay`, { method: 'pix', reference: 'E2E', justification: J })).statusCode).toBe(200);
    expect((await t.owner.get('/api/me')).statusCode).toBe(200);
    expect((await m.c.post(`/api/master/invoices/${inv.id}/pay`, { method: 'pix', justification: J })).statusCode).toBe(409);
    expect((await m.c.post(`/api/master/invoices/${inv.id}/void`, { reason: 'engano', justification: J })).statusCode).toBe(409);
    await expect(platformPool.query('UPDATE platform_invoices SET amount_cents = 1 WHERE id = $1', [inv.id])).rejects.toThrow();
    await expect(platformPool.query('DELETE FROM platform_invoices WHERE id = $1', [inv.id])).rejects.toThrow();
  });

  it('suspensão manual não é desfeita pela cobrança; anular fatura também regulariza', async () => {
    const { t, m } = await priced('bill2');
    await m.c.patch(`/api/master/tenants/${t.id}/billing`, { overrideCents: 9000, dueDay: 10, graceDays: 0, justification: J });
    await m.c.post('/api/master/billing/generate', { period: '2026-02', justification: J });
    const inv = (await m.c.get('/api/master/billing')).json().invoices.find((i: { tenantId: string }) => i.tenantId === t.id);
    expect((await m.c.patch(`/api/master/tenants/${t.id}`, { status: 'suspended', code: m.code(), justification: J })).statusCode).toBe(200);
    expect((await m.c.post(`/api/master/invoices/${inv.id}/void`, { reason: 'cobrança indevida', justification: J })).statusCode).toBe(200);
    expect((await t.owner.get('/api/me')).statusCode).toBe(403);   // continua suspensa: foi manual
    await m.c.patch(`/api/master/tenants/${t.id}`, { status: 'active', code: m.code(), justification: J });
  });

  it('o proprietário vê fatura, uso e aviso de atraso; os demais perfis não', async () => {
    const { t, m } = await priced('bill3');
    const rec = await t.mk('receptionist', 'recbl');
    await m.c.patch(`/api/master/tenants/${t.id}/billing`, { overrideCents: 5000, dueDay: 10, graceDays: 100000 > 60 ? 60 : 60, justification: J });
    await platformPool.query(`INSERT INTO platform_invoices (tenant_id, period, plan_code, amount_cents, due_date) VALUES ($1, date_trunc('month', now() - interval '5 days')::date, 'solo', 5000, (now() - interval '5 days')::date)`, [t.id]);
    const b = (await t.owner.get('/api/billing')).json();
    expect(b.invoices).toHaveLength(1);
    expect(b.status.state).toBe('late');
    expect(b.status.graceLeft).toBeGreaterThanOrEqual(54);
    expect(b.usage.users).toBeGreaterThanOrEqual(2);
    expect((await t.owner.get('/api/me')).json().billing.state).toBe('late');
    expect((await rec.c.get('/api/me')).json().billing).toBeNull();
    expect((await rec.c.get('/api/billing')).statusCode).toBe(403);
    // clínica não vê fatura de outra
    const o = await tenant('bill-other', 'solo');
    expect((await o.owner.get('/api/billing')).json().invoices).toHaveLength(0);
  });

  it('limites do plano recusam novos usuários, pacientes e arquivos; sem limite nada muda', async () => {
    const m = await master();
    const t = await tenant('lim', 'enterprise');
    // limite no plano enterprise afetaria outros testes em paralelo: usa o preço/limite e restaura no fim
    const before = (await m.c.get('/api/master/billing')).json().plans.find((p: { code: string }) => p.code === 'enterprise');
    try {
      const set = (u: number | null, p: number | null, s: number | null) => m.c.patch('/api/master/plans/enterprise', { priceCents: before.priceCents, maxUsers: u, maxPatients: p, maxStorageMb: s, code: m.code(), justification: J });
      expect((await set(2, 1, null)).statusCode).toBe(200);
      const pdf = Buffer.from('%PDF-1.4\nx\n%%EOF').toString('base64');
      expect((await t.owner.post('/api/users', { name: 'Segundo Usuario', email: `u2@${t.slug}.test`, role: 'receptionist', password: PW })).statusCode).toBe(200);
      const over = await t.owner.post('/api/users', { name: 'Terceiro Usuario', email: `u3@${t.slug}.test`, role: 'receptionist', password: PW });
      expect(over.statusCode).toBe(409);
      expect(over.json().error).toBe('plan_limit');
      const p1 = await t.owner.post('/api/patients', { name: 'Primeiro Paciente' });
      expect(p1.statusCode).toBe(200);
      expect((await t.owner.post('/api/patients', { name: 'Segundo Paciente' })).json().error).toBe('plan_limit');
      expect((await set(null, null, 1)).statusCode).toBe(200);
      expect((await t.owner.post(`/api/patients/${p1.json().id}/documents`, { title: 'Termo', category: 'other', fileName: 'a.pdf', contentBase64: pdf })).statusCode).toBe(200);
      const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1_100_000, 65), Buffer.from('\n%%EOF')]).toString('base64');
      expect((await t.owner.post(`/api/patients/${p1.json().id}/documents`, { title: 'Grande', category: 'other', fileName: 'b.pdf', contentBase64: big })).json().error).toBe('plan_limit');
      expect((await set(null, null, null)).statusCode).toBe(200);
      expect((await t.owner.post('/api/patients', { name: 'Terceiro Paciente' })).statusCode).toBe(200);
    } finally {
      await platformPool.query('UPDATE plans SET max_users = NULL, max_patients = NULL, max_storage_mb = NULL, price_cents = $1 WHERE code = $2', [before.priceCents, 'enterprise']);
    }
  });

  it('a clínica vê o que o suporte abriu; sem concessão, nem o banco deixa o suporte ler', async () => {
    const { t, m } = await priced('sup');
    const rec = await t.mk('receptionist', 'recsp');
    await t.owner.post('/api/patients', { name: 'Paciente Sigiloso' });
    // sem concessão: abrir é recusado e o papel da plataforma não lê equipe nem auditoria
    expect((await m.c.post(`/api/master/tenants/${t.id}/support/open`, { code: m.code(), justification: J })).statusCode).toBe(409);
    const direct = (sql: string) => platformPool.query(sql, [t.id]);
    expect((await direct('SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1')).rows[0].n).toBe(0);
    expect((await direct(`SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND role <> 'owner'`)).rows[0].n).toBe(0);
    // só o proprietário concede; prazo máximo de 24 h; uma por vez
    expect((await rec.c.post('/api/support-grants', { hours: 2, reason: 'ajuda com agenda' })).statusCode).toBe(403);
    expect((await t.owner.post('/api/support-grants', { hours: 25, reason: 'ajuda com agenda' })).statusCode).toBe(400);
    expect((await t.owner.post('/api/support-grants', { hours: 2, reason: 'xx' })).statusCode).toBe(400);
    const gr = await t.owner.post('/api/support-grants', { hours: 2, reason: 'ajuda com agenda' });
    expect(gr.statusCode).toBe(200);
    expect((await t.owner.post('/api/support-grants', { hours: 2, reason: 'ajuda com agenda' })).statusCode).toBe(409);

    const open = await m.c.post(`/api/master/tenants/${t.id}/support/open`, { code: m.code(), justification: J });
    expect(open.statusCode).toBe(200);
    const d = open.json();
    expect(d.users.map((u: { role: string }) => u.role)).toContain('receptionist');
    expect(JSON.stringify(d)).not.toContain('Paciente Sigiloso');
    expect(d.audit.some((a: { action: string }) => a.action === 'support.granted')).toBe(true);
    expect(d.audit[0]).not.toHaveProperty('metadata');
    // dado clínico continua fora do alcance do papel da plataforma, mesmo com concessão
    await expect(platformPool.query('SELECT name FROM patients WHERE tenant_id = $1', [t.id])).rejects.toThrow();
    expect((await m.c.get('/api/master/support')).json().grants.some((g: { tenantId: string }) => g.tenantId === t.id)).toBe(true);

    // a clínica enxerga o acesso e revoga; depois, nada
    const list = (await t.owner.get('/api/support-grants')).json();
    expect(list.accessLog).toHaveLength(1);
    expect(list.accessLog[0].operator).toBe(m.email);
    const id = gr.json().id as string;
    expect((await t.owner.post(`/api/support-grants/${id}/revoke`)).statusCode).toBe(200);
    expect((await t.owner.post(`/api/support-grants/${id}/revoke`)).statusCode).toBe(404);
    expect((await m.c.post(`/api/master/tenants/${t.id}/support/open`, { code: m.code(), justification: J })).statusCode).toBe(409);
    expect((await direct('SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1')).rows[0].n).toBe(0);
    // concessão e log são imutáveis
    await expect(platformPool.query('UPDATE support_grants SET expires_at = expires_at + interval \'1 day\' WHERE id = $1', [id])).rejects.toThrow();
    await expect(platformPool.query('DELETE FROM support_access_log WHERE tenant_id = $1', [t.id])).rejects.toThrow();
    // outra clínica não vê a concessão
    const o = await tenant('sup-other', 'solo');
    expect((await o.owner.get('/api/support-grants')).json().grants).toHaveLength(0);
    void Client;
  });
});
