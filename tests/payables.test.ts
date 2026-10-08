import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { addMonths } from '../src/server/routes/payables.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

// Datas no fuso da clínica (São Paulo), como o servidor as interpreta.
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
type Row = { id: string; status: string; overdue: boolean; amountCents: string; dueOn: string; installment: number; installments: number };
const list = async (c: { get: (u: string) => Promise<{ json: () => any }> }, qs = '') => (await c.get(`/api/payables${qs}`)).json() as { payables: Row[]; summary: Record<string, string | number> };

describe('contas a pagar', () => {
  it('soma de meses respeita fim de mês', () => {
    expect(addMonths('2031-01-31', 1)).toBe('2031-02-28');
    expect(addMonths('2031-11-15', 3)).toBe('2032-02-15');
    expect(addMonths('2032-01-31', 1)).toBe('2032-02-29');
  });

  it('exige o plano com financeiro avançado e perfil autorizado', async () => {
    const solo = await tenant('payplan', 'essencial');
    expect((await solo.owner.get('/api/payables')).json().error).toBe('capability_unavailable');
    const t = await tenant('payrbac');
    const rec = await t.mk('receptionist', 'rita');
    const fin = await t.mk('finance', 'fabio');
    const aud = await t.mk('auditor', 'aud');
    expect((await rec.c.get('/api/payables')).statusCode).toBe(403);
    expect((await fin.c.post('/api/payables', { description: 'Aluguel', amountCents: 100000, dueOn: day(5) })).statusCode).toBe(200);
    expect((await aud.c.get('/api/payables')).statusCode).toBe(200);                       // auditor lê
    expect((await aud.c.post('/api/payables', { description: 'x y', amountCents: 100, dueOn: day(5) })).statusCode).toBe(403); // mas não grava
  });

  it('cria, parcela, atrasa, paga e cancela; resumo acompanha', async () => {
    const t = await tenant('payflow');
    const post = (b: object) => t.owner.post('/api/payables', b);
    expect((await post({ description: 'Aluguel', supplier: 'Imobiliária', amountCents: 250000, dueOn: day(-3) })).statusCode).toBe(200);   // atrasada
    expect((await post({ description: 'Luz', amountCents: 40000, dueOn: day(3) })).statusCode).toBe(200);                                  // vence em breve
    const inst = await post({ description: 'Cadeira odontológica', amountCents: 90000, dueOn: day(10), installments: 3 });
    expect(inst.json().ids).toHaveLength(3);
    expect((await post({ description: 'x', amountCents: 100, dueOn: day(1) })).statusCode).toBe(400);   // descrição curta
    expect((await post({ description: 'Zero', amountCents: 0, dueOn: day(1) })).statusCode).toBe(400);
    expect((await post({ description: 'Data ruim', amountCents: 100, dueOn: '2031-13-45' })).statusCode).toBe(400);

    let l = await list(t.owner);
    expect(l.payables).toHaveLength(5);
    expect(l.payables[0]).toMatchObject({ overdue: true, amountCents: '250000' });                       // ordenadas por vencimento
    const parcelas = l.payables.filter((p) => p.installments === 3).sort((a, b) => a.installment - b.installment);
    expect(parcelas.map((p) => p.installment)).toEqual([1, 2, 3]);
    expect(parcelas[1]!.dueOn).toBe(addMonths(day(10), 1));
    expect(l.summary).toMatchObject({ openCents: String(250000 + 40000 + 3 * 90000), overdueCents: '250000', overdueCount: 1, dueSoonCents: '40000' });

    const aluguel = l.payables[0]!.id;
    expect((await t.owner.post(`/api/payables/${aluguel}/pay`, { method: 'pix', paidOn: day(2) })).statusCode).toBe(400); // data futura
    expect((await t.owner.post(`/api/payables/${aluguel}/pay`, { method: 'pix', paidCents: 252500 })).statusCode).toBe(200);  // pago com juros
    expect((await t.owner.post(`/api/payables/${aluguel}/pay`, { method: 'pix' })).statusCode).toBe(409);                      // já paga
    expect((await t.owner.patch(`/api/payables/${aluguel}`, { amountCents: 1 })).statusCode).toBe(409);                       // paga não muda
    expect((await t.owner.post(`/api/payables/${aluguel}/cancel`, { reason: 'engano' })).statusCode).toBe(409);

    const luz = l.payables.find((p) => p.amountCents === '40000')!.id;
    expect((await t.owner.patch(`/api/payables/${luz}`, { amountCents: 42000, dueOn: day(4) })).statusCode).toBe(200);
    expect((await t.owner.post(`/api/payables/${luz}/cancel`, { reason: 'x' })).statusCode).toBe(400);                         // motivo curto
    expect((await t.owner.post(`/api/payables/${luz}/cancel`, { reason: 'Conta em duplicidade' })).statusCode).toBe(200);
    expect((await t.owner.post(`/api/payables/${luz}/pay`, { method: 'cash' })).statusCode).toBe(409);                         // cancelada não paga

    l = await list(t.owner);
    expect(l.summary).toMatchObject({ openCents: String(3 * 90000), overdueCount: 0, paidThisMonthCents: '252500' });
    expect((await list(t.owner, '?status=paid')).payables).toHaveLength(1);
    expect((await list(t.owner, '?status=canceled')).payables).toHaveLength(1);
    expect((await list(t.owner, '?status=all')).payables).toHaveLength(5);
    expect((await list(t.owner, '?q=cadeira')).payables).toHaveLength(3);
  });

  it('pagamento simultâneo da mesma conta só vale uma vez; banco protege conta definitiva e exclusão; isolamento', async () => {
    const t = await tenant('paycon');
    const id = (await t.owner.post('/api/payables', { description: 'Fornecedor', amountCents: 5000, dueOn: day(1) })).json().ids[0] as string;
    const rs = await Promise.all([1, 2, 3].map(() => t.owner.post(`/api/payables/${id}/pay`, { method: 'boleto' })));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    const run = (sql: string) => withTenant(appPool, t.id, (tx) => tx.query(sql));
    await expect(run('UPDATE payables SET amount_cents = 1')).rejects.toThrow(/definitiva/);
    await expect(run('DELETE FROM payables')).rejects.toThrow(/cancele-a|permission denied/);
    const other = await tenant('payother');
    expect((await list(other.owner)).payables).toHaveLength(0);
    expect((await other.owner.post(`/api/payables/${id}/cancel`, { reason: 'invasão' })).statusCode).toBe(404);
  });
});
