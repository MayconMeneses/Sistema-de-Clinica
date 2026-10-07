import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

type T = Awaited<ReturnType<typeof tenant>>;
let seq = 0;
const key = () => `cash-test-key-${Date.now()}-${seq++}`;

async function patientWithCharge(t: T, cents = 15000) {
  const pid = (await t.owner.post('/api/patients', { name: `Paciente Caixa ${seq++}` })).json().id as string;
  expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'charge', amountCents: cents })).statusCode).toBe(200);
  return pid;
}
const balance = async (t: T, pid: string) => (await t.owner.get(`/api/patients/${pid}/finance`)).json().balanceCents as string;

describe('caixa', () => {
  it('exige o plano com financeiro avançado', async () => {
    const t = await tenant('cashplan', 'essencial');
    const r = await t.owner.get('/api/cash/current');
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('capability_unavailable');
    // sem o avançado, dinheiro continua funcionando como antes (sem caixa)
    const pid = await patientWithCharge(t);
    expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'payment', method: 'cash', amountCents: 1000 })).statusCode).toBe(200);
  });

  it('abre, recebe, devolve, confere e fecha; diferença exige explicação; caixa fechado não aceita lançamento', async () => {
    const t = await tenant('cashflow');
    const pid = await patientWithCharge(t, 50000);

    // dinheiro sem caixa aberto é recusado; Pix não depende do caixa
    expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'payment', method: 'cash', amountCents: 500, idempotencyKey: key() })).statusCode).toBe(409);
    expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'payment', method: 'pix', amountCents: 500, idempotencyKey: key() })).statusCode).toBe(200);
    expect((await t.owner.get('/api/cash/current')).json().session).toBeNull();

    expect((await t.owner.post('/api/cash/open', { openingCents: 5000 })).statusCode).toBe(200);
    expect((await t.owner.post('/api/cash/open', { openingCents: 100 })).statusCode).toBe(409); // um caixa aberto por clínica

    expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'payment', method: 'cash', amountCents: 10000, idempotencyKey: key() })).statusCode).toBe(200);
    expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'payment', method: 'pix', amountCents: 2000, idempotencyKey: key() })).statusCode).toBe(200);
    expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'refund', method: 'cash', amountCents: 1500, idempotencyKey: key() })).statusCode).toBe(200);

    const cur = (await t.owner.get('/api/cash/current')).json();
    expect(cur.expectedCashCents).toBe('13500'); // 5000 + 10000 − 1500 (Pix não entra no dinheiro)
    const pix = (cur.byMethod as { method: string; receivedCents: string }[]).find((m) => m.method === 'pix')!;
    expect(pix.receivedCents).toBe('2000');

    // contado diferente do esperado sem explicação: recusa
    expect((await t.owner.post('/api/cash/close', { countedCents: 13000 })).statusCode).toBe(400);
    const closed = await t.owner.post('/api/cash/close', { countedCents: 13000, note: 'Faltou troco de R$ 5,00' });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().differenceCents).toBe('-500');
    expect(closed.json().expectedCents).toBe('13500');

    expect((await t.owner.post('/api/cash/close', { countedCents: 0 })).statusCode).toBe(409); // já fechado
    expect((await t.owner.get('/api/cash/current')).json().session).toBeNull();
    expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'payment', method: 'cash', amountCents: 100, idempotencyKey: key() })).statusCode).toBe(409);

    const hist = (await t.owner.get('/api/cash/sessions')).json().sessions as { differenceCents: string; closedAt: string }[];
    expect(hist).toHaveLength(1);
    expect(hist[0]!.differenceCents).toBe('-500');
  });

  it('fechamento sem diferença não exige observação; recepção opera o caixa; profissional não vê', async () => {
    const t = await tenant('cashroles');
    const rec = await t.mk('receptionist', 'rita');
    const pro = await t.mk('professional', 'dr');
    expect((await pro.c.get('/api/cash/current')).statusCode).toBe(403);
    expect((await rec.c.post('/api/cash/open', { openingCents: 2000 })).statusCode).toBe(200);
    const closed = await rec.c.post('/api/cash/close', { countedCents: 2000 });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().differenceCents).toBe('0');
  });

  it('o banco recusa mexer em caixa fechado e lançar nele, mesmo fora da API', async () => {
    const t = await tenant('cashdb');
    const pid = await patientWithCharge(t);
    expect((await t.owner.post('/api/cash/open', { openingCents: 0 })).statusCode).toBe(200);
    expect((await t.owner.post('/api/cash/close', { countedCents: 0 })).statusCode).toBe(200);
    const sid = ((await t.owner.get('/api/cash/sessions')).json().sessions as { id: string }[])[0]!.id;
    // Pelo papel da aplicação (o owner não enxerga linhas sob FORCE RLS), direto no SQL, sem passar pela API.
    const run = (sql: string, params: unknown[]) => withTenant(appPool, t.id, (tx) => tx.query(sql, params));
    await expect(run('UPDATE cash_sessions SET counted_cents = 999 WHERE id = $1', [sid])).rejects.toThrow(/imutável/);
    await expect(run('DELETE FROM cash_sessions WHERE id = $1', [sid])).rejects.toThrow(/append-only|permission denied/);
    await expect(run(
      `INSERT INTO financial_movements (tenant_id, patient_id, kind, method, amount_cents, cash_session_id)
       VALUES ($1,$2,'payment','cash',100,$3)`, [t.id, pid, sid])).rejects.toThrow(/caixa fechado/);
  });

  it('um caixa de uma clínica não aparece em outra', async () => {
    const a = await tenant('cashiso-a');
    const b = await tenant('cashiso-b');
    expect((await a.owner.post('/api/cash/open', { openingCents: 1000 })).statusCode).toBe(200);
    expect((await b.owner.get('/api/cash/current')).json().session).toBeNull();
    expect(((await b.owner.get('/api/cash/sessions')).json().sessions as unknown[]).length).toBe(0);
  });
});

describe('recibos', () => {
  it('numeração sequencial por clínica; recibo só de pagamento; não é documento fiscal; isolado entre clínicas', async () => {
    const a = await tenant('rcpt-a');
    const b = await tenant('rcpt-b');
    const pa = await patientWithCharge(a);
    const pb = await patientWithCharge(b);
    const p1 = (await a.owner.post('/api/finance/movements', { patientId: pa, kind: 'payment', method: 'pix', amountCents: 3000, idempotencyKey: key() })).json();
    const p2 = (await a.owner.post('/api/finance/movements', { patientId: pa, kind: 'payment', method: 'card', amountCents: 2000, idempotencyKey: key() })).json();
    const pB = (await b.owner.post('/api/finance/movements', { patientId: pb, kind: 'payment', method: 'pix', amountCents: 1000, idempotencyKey: key() })).json();
    expect([p1.receiptNumber, p2.receiptNumber]).toEqual([1, 2]);
    expect(pB.receiptNumber).toBe(1); // contador por clínica

    // pagamento duplicado (mesma chave) não consome número
    const k = key();
    const d1 = (await a.owner.post('/api/finance/movements', { patientId: pa, kind: 'payment', method: 'pix', amountCents: 100, idempotencyKey: k })).json();
    const d2 = (await a.owner.post('/api/finance/movements', { patientId: pa, kind: 'payment', method: 'pix', amountCents: 100, idempotencyKey: k })).json();
    expect(d1.receiptNumber).toBe(3);
    expect(d2.duplicate).toBe(true);
    const next = (await a.owner.post('/api/finance/movements', { patientId: pa, kind: 'payment', method: 'pix', amountCents: 100, idempotencyKey: key() })).json();
    expect(next.receiptNumber).toBe(4);

    const rec = (await a.owner.get(`/api/finance/movements/${p1.id}/receipt`)).json();
    expect(rec).toMatchObject({ number: 1, amountCents: '3000', method: 'pix', clinicName: 'Clínica rcpt-a', fiscal: false });
    expect(rec.patientName).toMatch(/Paciente Caixa/);

    const movements = (await a.owner.get(`/api/patients/${pa}/finance`)).json().movements as { id: string; kind: string }[];
    const charge = movements.find((m) => m.kind === 'charge')!;
    expect((await a.owner.get(`/api/finance/movements/${charge.id}/receipt`)).statusCode).toBe(404);
    expect((await b.owner.get(`/api/finance/movements/${p1.id}/receipt`)).statusCode).toBe(404); // RLS
  });
});

describe('descontos com aprovação', () => {
  it('recepção pede, financeiro aprova; saldo cai uma única vez; decisão é definitiva', async () => {
    const t = await tenant('disc');
    const rec = await t.mk('receptionist', 'rita');
    const fin = await t.mk('finance', 'fabio');
    const pid = await patientWithCharge(t, 15000);

    expect((await rec.c.post('/api/finance/discount-requests', { patientId: pid, amountCents: 20000, reason: 'Desconto maior que a dívida' })).statusCode).toBe(400);
    expect((await rec.c.post('/api/finance/discount-requests', { patientId: pid, amountCents: 2000, reason: 'ab' })).statusCode).toBe(400);
    const req = await rec.c.post('/api/finance/discount-requests', { patientId: pid, amountCents: 2000, reason: 'Paciente antigo da clínica' });
    expect(req.statusCode).toBe(200);
    const id = req.json().id as string;
    expect(await balance(t, pid)).toBe('15000'); // pedido ainda não mexe no saldo

    expect((await rec.c.post(`/api/finance/discount-requests/${id}/decide`, { decision: 'approve' })).statusCode).toBe(403); // recepção não aprova
    const pending = (await fin.c.get('/api/finance/discount-requests?status=pending')).json().requests as { id: string; patientName: string; requestedByName: string }[];
    expect(pending.map((r) => r.id)).toContain(id);

    const ok = await fin.c.post(`/api/finance/discount-requests/${id}/decide`, { decision: 'approve' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('approved');
    expect(await balance(t, pid)).toBe('13000');
    expect((await fin.c.post(`/api/finance/discount-requests/${id}/decide`, { decision: 'approve' })).statusCode).toBe(409);
    expect(await balance(t, pid)).toBe('13000');

    const movements = (await t.owner.get(`/api/patients/${pid}/finance`)).json();
    expect(movements.discountedCents).toBe('2000');
    expect((movements.movements as { kind: string }[]).some((m) => m.kind === 'discount')).toBe(true);

    const audit = (await t.owner.get('/api/audit')).json().events as { action: string }[];
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['discount.request', 'discount.approve']));
  });

  it('recusa exige motivo e não altera o saldo; desconto não nasce pela rota de movimentos', async () => {
    const t = await tenant('discrej');
    const rec = await t.mk('receptionist', 'rita');
    const pid = await patientWithCharge(t, 10000);
    const id = (await rec.c.post('/api/finance/discount-requests', { patientId: pid, amountCents: 1000, reason: 'Pedido de teste' })).json().id as string;
    expect((await t.owner.post(`/api/finance/discount-requests/${id}/decide`, { decision: 'reject' })).statusCode).toBe(400);
    const rej = await t.owner.post(`/api/finance/discount-requests/${id}/decide`, { decision: 'reject', note: 'Fora da política' });
    expect(rej.statusCode).toBe(200);
    expect(await balance(t, pid)).toBe('10000');
    expect((await t.owner.post(`/api/finance/discount-requests/${id}/decide`, { decision: 'approve' })).statusCode).toBe(409);
    expect((await t.owner.post('/api/finance/movements', { patientId: pid, kind: 'discount', amountCents: 500 })).statusCode).toBe(400);
  });

  it('quem pediu não aprova o próprio desconto, exceto o proprietário; duas aprovações simultâneas valem uma', async () => {
    const t = await tenant('discself');
    const fin = await t.mk('finance', 'fabio');
    const fin2 = await t.mk('finance', 'flavia');
    const pid = await patientWithCharge(t, 10000);

    const own = (await fin.c.post('/api/finance/discount-requests', { patientId: pid, amountCents: 1000, reason: 'Pedido do financeiro' })).json().id as string;
    expect((await fin.c.post(`/api/finance/discount-requests/${own}/decide`, { decision: 'approve' })).statusCode).toBe(403);
    const [a, b] = await Promise.all([
      fin2.c.post(`/api/finance/discount-requests/${own}/decide`, { decision: 'approve' }),
      t.owner.post(`/api/finance/discount-requests/${own}/decide`, { decision: 'approve' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await balance(t, pid)).toBe('9000'); // descontou uma vez só

    // proprietário pode aprovar o que ele mesmo pediu (clínica pequena); fica no registro de auditoria
    const mine = (await t.owner.post('/api/finance/discount-requests', { patientId: pid, amountCents: 500, reason: 'Pedido do dono' })).json().id as string;
    expect((await t.owner.post(`/api/finance/discount-requests/${mine}/decide`, { decision: 'approve' })).statusCode).toBe(200);
    expect(await balance(t, pid)).toBe('8500');
  });

  it('o saldo é revalidado na aprovação; pedidos de uma clínica não aparecem em outra', async () => {
    const a = await tenant('discval-a');
    const b = await tenant('discval-b');
    const pid = await patientWithCharge(a, 10000);
    const id = (await a.owner.post('/api/finance/discount-requests', { patientId: pid, amountCents: 8000, reason: 'Desconto grande' })).json().id as string;
    // paciente paga antes da aprovação: o desconto pedido passa a exceder o saldo
    expect((await a.owner.post('/api/finance/movements', { patientId: pid, kind: 'payment', method: 'pix', amountCents: 5000, idempotencyKey: key() })).statusCode).toBe(200);
    expect((await a.owner.post(`/api/finance/discount-requests/${id}/decide`, { decision: 'approve' })).statusCode).toBe(409);
    expect(await balance(a, pid)).toBe('5000');
    expect(((await b.owner.get('/api/finance/discount-requests')).json().requests as unknown[]).length).toBe(0);
    expect((await b.owner.post(`/api/finance/discount-requests/${id}/decide`, { decision: 'reject', note: 'x y z' })).statusCode).toBe(404);
  });
});
