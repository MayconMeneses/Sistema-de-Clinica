import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
type T = Awaited<ReturnType<typeof tenant>>;
type St = { professionals: { professionalId: string; name: string; chargesCount: number; baseCents: string; commissionCents: string; hasPayoutInPeriod: boolean }[]; unattributed: { count: number } };

async function clinic(label: string) {
  const t = await tenant(label);
  const dr = await t.mk('professional', 'dra');
  const proId = ((await t.owner.get('/api/professionals')).json().professionals as { id: string }[])[0]!.id;
  const pid = (await t.owner.post('/api/patients', { name: 'Paciente Comissão' })).json().id as string;
  let h = 7;
  const done = async (priceCents: number) => {
    const slot = (x: number) => new Date(`${today()}T${String(x).padStart(2, '0')}:00:00-03:00`).toISOString();
    const a = (await t.owner.post('/api/appointments', { patientId: pid, professionalId: proId, startsAt: slot(h), endsAt: slot(h + 1), service: 'Consulta', priceCents, encaixe: true })).json().id as string;
    h += 2;
    for (const status of ['checked_in', 'completed']) expect((await t.owner.patch(`/api/appointments/${a}`, { status })).statusCode).toBe(200);
  };
  return { t, dr, proId, pid, done };
}
const stmt = async (t: T, from = today(), to = today()) => (await t.owner.get(`/api/commissions/statement?from=${from}&to=${to}`)).json() as St;

describe('comissões e repasses', () => {
  it('exige plano e perfil: financeiro/dono gerenciam, auditor lê, recepção e profissional não veem', async () => {
    const solo = await tenant('complan', 'essencial');
    expect((await solo.owner.get('/api/commissions/rules')).json().error).toBe('capability_unavailable');
    const t = await tenant('comrbac');
    const fin = await t.mk('finance', 'fabio');
    const aud = await t.mk('auditor', 'aud');
    const rec = await t.mk('receptionist', 'rita');
    const prof = await t.mk('professional', 'pro');
    expect((await fin.c.get('/api/commissions/rules')).statusCode).toBe(200);
    expect((await aud.c.get('/api/commissions/rules')).statusCode).toBe(200);
    expect((await aud.c.post('/api/commissions/rules', { professionalId: '00000000-0000-4000-8000-000000000000', percent: 10 })).statusCode).toBe(403);
    expect((await rec.c.get('/api/commissions/rules')).statusCode).toBe(403);
    expect((await prof.c.get('/api/commissions/rules')).statusCode).toBe(403);
  });

  it('calcula a comissão sobre a produção com o percentual vigente e mantém o histórico de regras', async () => {
    const { t, proId, done } = await clinic('comcalc');
    expect((await t.owner.post('/api/commissions/rules', { professionalId: proId, percent: 150 })).statusCode).toBe(400);   // máximo 100
    expect((await t.owner.post('/api/commissions/rules', { professionalId: proId, percent: 10.555 })).statusCode).toBe(400); // 2 casas
    expect((await t.owner.post('/api/commissions/rules', { professionalId: t.id, percent: 10 })).statusCode).toBe(404);       // não é profissional
    await done(10000);
    expect((await stmt(t)).professionals[0]).toMatchObject({ chargesCount: 1, baseCents: '10000', commissionCents: '0' });   // sem regra = 0
    expect((await t.owner.post('/api/commissions/rules', { professionalId: proId, percent: 30 })).statusCode).toBe(200);
    await done(25000);
    const s = await stmt(t);
    expect(s.professionals[0]).toMatchObject({ chargesCount: 2, baseCents: '35000', commissionCents: '10500' });         // a regra vale por dia: as duas cobranças de hoje usam 30% (30% de 350,00)
    // regra com vigência futura não afeta o hoje
    expect((await t.owner.post('/api/commissions/rules', { professionalId: proId, percent: 50, effectiveFrom: shift(today(), 5) })).statusCode).toBe(200);
    expect((await stmt(t)).professionals[0]!.commissionCents).toBe('10500');   // 30% de 350,00
    const rules = (await t.owner.get('/api/commissions/rules')).json().rules as { percentBp: number }[];
    expect(rules[0]!.percentBp).toBe(3000);
    const detail = (await t.owner.get(`/api/commissions/statement/${proId}?from=${today()}&to=${today()}`)).json().charges as { amountCents: string; commissionCents: string }[];
    expect(detail).toHaveLength(2);
    expect(detail.reduce((a, c) => a + Number(c.commissionCents), 0)).toBe(10500);
    expect((await t.owner.get(`/api/commissions/statement?from=${today()}&to=${shift(today(), -1)}`)).statusCode).toBe(400);
    // outro dia sem produção
    expect((await stmt(t, shift(today(), -10), shift(today(), -5))).professionals[0]).toMatchObject({ chargesCount: 0, commissionCents: '0' });
  });

  it('repasse: valor calculado no servidor, períodos não se sobrepõem, anulação libera, tudo imutável', async () => {
    const { t, proId, done } = await clinic('compay');
    await t.owner.post('/api/commissions/rules', { professionalId: proId, percent: 20, effectiveFrom: shift(today(), -30) });
    await done(50000);
    const payBody = { professionalId: proId, from: today(), to: today(), method: 'pix' };
    expect((await t.owner.post('/api/commissions/payouts', { ...payBody, to: shift(today(), 1) })).statusCode).toBe(400);   // período não encerrado
    expect((await t.owner.post('/api/commissions/payouts', { ...payBody, amountCents: 999999 })).json().amountCents).toBe('10000'); // valor do cliente é ignorado
    expect((await stmt(t)).professionals[0]!.hasPayoutInPeriod).toBe(true);
    expect((await t.owner.post('/api/commissions/payouts', payBody)).statusCode).toBe(409);                                   // sobreposição
    const list = (await t.owner.get('/api/commissions/payouts')).json().payouts as { id: string; voided: boolean; amountCents: string }[];
    expect(list).toHaveLength(1);
    const run = (sql: string) => withTenant(appPool, t.id, (tx) => tx.query(sql));
    await expect(run('UPDATE commission_payouts SET amount_cents = 1')).rejects.toThrow(/imutáveis/);
    await expect(run('DELETE FROM commission_payouts')).rejects.toThrow(/anule-o|permission denied/);
    await expect(run('UPDATE commission_rules SET percent_bp = 1')).rejects.toThrow(/permission denied|append-only/);

    const id = list[0]!.id;
    expect((await t.owner.post(`/api/commissions/payouts/${id}/void`, { reason: 'x' })).statusCode).toBe(400);
    expect((await t.owner.post(`/api/commissions/payouts/${id}/void`, { reason: 'Lançado com a forma de pagamento errada' })).statusCode).toBe(200);
    expect((await t.owner.post(`/api/commissions/payouts/${id}/void`, { reason: 'de novo' })).statusCode).toBe(409);
    expect((await stmt(t)).professionals[0]!.hasPayoutInPeriod).toBe(false);
    expect((await t.owner.post('/api/commissions/payouts', payBody)).statusCode).toBe(200);                                    // anulado libera o período
    // sem comissão no período: recusa
    expect((await t.owner.post('/api/commissions/payouts', { ...payBody, from: shift(today(), -9), to: shift(today(), -8) })).statusCode).toBe(400);
  });

  it('isolamento entre clínicas', async () => {
    const a = await clinic('comisoa');
    await a.t.owner.post('/api/commissions/rules', { professionalId: a.proId, percent: 10 });
    await a.done(10000);
    const b = await tenant('comisob');
    expect((await stmt(b)).professionals).toHaveLength(0);
    expect((await b.owner.post('/api/commissions/rules', { professionalId: a.proId, percent: 99 })).statusCode).toBe(404);
  });
});
