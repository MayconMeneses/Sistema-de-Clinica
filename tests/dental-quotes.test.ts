import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const todaySp = (plusDays = 0) => new Date(Date.now() + plusDays * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const ITEMS = [
  { procedure: 'Restauração em resina', tooth: '16', priceCents: 25000 },
  { procedure: 'Limpeza', priceCents: 15000 },
];

async function setup(label = 'quote') {
  const t = await tenant(label);
  const dr = await t.mk('professional', 'dr');
  const rec = await t.mk('receptionist', 'rita');
  const pid = (await t.owner.post('/api/patients', { name: 'Paciente Orçamento' })).json().id as string;
  return { t, dr, rec, pid };
}
const quotes = async (c: { get: (u: string) => Promise<{ json: () => unknown }> }, pid: string) =>
  ((await c.get(`/api/patients/${pid}/dental-quotes`)).json() as { quotes: { id: string; groupId: string; version: number; status: string; totalCents: string; items: unknown[] }[] }).quotes;

describe('orçamento odontológico', () => {
  it('exige o recurso odontograma no plano e respeita os perfis', async () => {
    const solo = await tenant('quote-plan', 'essencial');
    const pid0 = (await solo.owner.post('/api/patients', { name: 'Sem Odonto' })).json().id as string;
    const r = await solo.owner.get(`/api/patients/${pid0}/dental-quotes`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('capability_unavailable');

    const { t, dr, rec, pid } = await setup('quoterbac');
    expect((await rec.c.get(`/api/patients/${pid}/dental-quotes`)).statusCode).toBe(403); // recepção não vê dados clínicos
    expect((await t.owner.post(`/api/patients/${pid}/dental-quotes`, { items: ITEMS })).statusCode).toBe(403); // dono lê, mas quem cria é o profissional
    expect((await t.owner.get(`/api/patients/${pid}/dental-quotes`)).statusCode).toBe(200);
    expect((await dr.c.post(`/api/patients/${pid}/dental-quotes`, { items: [] })).statusCode).toBe(400);
    expect((await dr.c.post(`/api/patients/${pid}/dental-quotes`, { items: [{ procedure: 'Dente inválido', tooth: '99', priceCents: 100 }] })).statusCode).toBe(400);
  });

  it('rascunho → apresentado (congela) → nova versão substitui a anterior → aceite gera o plano de tratamento uma vez', async () => {
    const { t, dr, pid } = await setup('quoteflow');
    const id1 = (await dr.c.post(`/api/patients/${pid}/dental-quotes`, { items: ITEMS, notes: 'Primeira proposta' })).json().id as string;

    // rascunho pode ser editado
    expect((await dr.c.patch(`/api/dental-quotes/${id1}`, { items: [...ITEMS, { procedure: 'Selante', tooth: '26', priceCents: 8000 }] })).statusCode).toBe(200);
    let qs = await quotes(dr.c, pid);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ version: 1, status: 'draft', totalCents: '48000' });

    // não aceita nem recusa antes de apresentar
    expect((await dr.c.post(`/api/dental-quotes/${id1}/accept`, { acceptedByName: 'Paciente Orçamento', acceptedByRole: 'patient' })).statusCode).toBe(409);
    expect((await dr.c.post(`/api/dental-quotes/${id1}/present`)).statusCode).toBe(200);
    expect((await dr.c.post(`/api/dental-quotes/${id1}/present`)).statusCode).toBe(409);
    expect((await dr.c.patch(`/api/dental-quotes/${id1}`, { notes: 'mudou' })).statusCode).toBe(409); // congelado

    // nova versão: copia os itens como rascunho; só um rascunho por vez
    const rev = await dr.c.post(`/api/dental-quotes/${id1}/revise`);
    expect(rev.statusCode).toBe(200);
    expect(rev.json().version).toBe(2);
    const id2 = rev.json().id as string;
    expect((await dr.c.post(`/api/dental-quotes/${id1}/revise`)).statusCode).toBe(409);
    expect((await dr.c.patch(`/api/dental-quotes/${id2}`, { items: ITEMS })).statusCode).toBe(200); // v2 sem o selante
    expect((await dr.c.post(`/api/dental-quotes/${id2}/present`)).statusCode).toBe(200);

    qs = await quotes(dr.c, pid);
    expect(qs.find((q) => q.id === id1)!.status).toBe('superseded'); // v1 foi substituída
    expect(qs.find((q) => q.id === id2)).toMatchObject({ status: 'presented', version: 2, totalCents: '40000' });
    expect((await dr.c.post(`/api/dental-quotes/${id1}/accept`, { acceptedByName: 'Paciente Orçamento', acceptedByRole: 'patient' })).statusCode).toBe(409);

    // aceite: duas tentativas simultâneas valem uma; o plano recebe os itens uma única vez
    const accept = () => dr.c.post(`/api/dental-quotes/${id2}/accept`, { acceptedByName: 'Paciente Orçamento', acceptedByRole: 'patient', note: 'Aceitou no balcão' });
    const [a, b] = await Promise.all([accept(), accept()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const plan = (await dr.c.get(`/api/patients/${pid}/dental-plan`)).json();
    expect(plan.items).toHaveLength(2);
    expect(plan.openTotalCents).toBe('40000');
    expect((plan.items as { status: string }[]).every((i) => i.status === 'planned')).toBe(true);

    qs = await quotes(dr.c, pid);
    const acc = qs.find((q) => q.id === id2) as unknown as { status: string; acceptedByName: string; acceptedByRole: string; decidedByName: string };
    expect(acc).toMatchObject({ status: 'accepted', acceptedByName: 'Paciente Orçamento', acceptedByRole: 'patient' });
    expect(acc.decidedByName).toBeTruthy();
    expect((await dr.c.post(`/api/dental-quotes/${id2}/revise`)).statusCode).toBe(409); // aceito não ganha nova versão
    expect((await dr.c.post(`/api/dental-quotes/${id2}/reject`, { reason: 'Mudou de ideia' })).statusCode).toBe(409);

    const audit = ((await t.owner.get('/api/audit')).json().events as { action: string }[]).map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['dental.quote.create', 'dental.quote.present', 'dental.quote.revise', 'dental.quote.accept']));
  });

  it('recusa exige motivo; depois da recusa é possível propor nova versão', async () => {
    const { dr, pid } = await setup('quoterej');
    const id = (await dr.c.post(`/api/patients/${pid}/dental-quotes`, { items: ITEMS })).json().id as string;
    await dr.c.post(`/api/dental-quotes/${id}/present`);
    expect((await dr.c.post(`/api/dental-quotes/${id}/reject`, { reason: 'x' })).statusCode).toBe(400);
    expect((await dr.c.post(`/api/dental-quotes/${id}/reject`, { reason: 'Achou caro' })).statusCode).toBe(200);
    expect((await dr.c.get(`/api/patients/${pid}/dental-plan`)).json().items).toHaveLength(0); // recusa não cria plano
    expect((await dr.c.post(`/api/dental-quotes/${id}/accept`, { acceptedByName: 'Fulano de Tal', acceptedByRole: 'patient' })).statusCode).toBe(409);
    const rev = await dr.c.post(`/api/dental-quotes/${id}/revise`);
    expect(rev.statusCode).toBe(200);
    expect(rev.json().version).toBe(2);
  });

  it('paciente menor de idade só aceita pelo responsável; validade vencida não apresenta', async () => {
    const { t, dr } = await setup('quoteminor');
    const kid = (await t.owner.post('/api/patients', { name: 'Criança Orçamento', birthDate: `${new Date().getFullYear() - 8}-03-10` })).json().id as string;
    const id = (await dr.c.post(`/api/patients/${kid}/dental-quotes`, { items: ITEMS })).json().id as string;
    await dr.c.post(`/api/dental-quotes/${id}/present`);
    expect((await dr.c.post(`/api/dental-quotes/${id}/accept`, { acceptedByName: 'Criança Orçamento', acceptedByRole: 'patient' })).statusCode).toBe(400);
    expect((await dr.c.post(`/api/dental-quotes/${id}/accept`, { acceptedByName: 'Mãe da Criança', acceptedByRole: 'guardian' })).statusCode).toBe(200);

    const adult = (await t.owner.post('/api/patients', { name: 'Adulto Vencido' })).json().id as string;
    const old = (await dr.c.post(`/api/patients/${adult}/dental-quotes`, { items: ITEMS, validUntil: todaySp(-1) })).json().id as string;
    expect((await dr.c.post(`/api/dental-quotes/${old}/present`)).statusCode).toBe(400);
    const today = (await dr.c.post(`/api/patients/${adult}/dental-quotes`, { items: ITEMS, validUntil: todaySp(0) })).json().id as string;
    expect((await dr.c.post(`/api/dental-quotes/${today}/present`)).statusCode).toBe(200); // vale até o fim do dia
    const presented = (await quotes(dr.c, adult)).find((q) => q.id === today) as unknown as { validUntil: string };
    expect(presented.validUntil).toBe(todaySp(0));
  });

  it('o banco recusa alterar orçamento apresentado (conteúdo e itens), mesmo fora da API', async () => {
    const { t, dr, pid } = await setup('quotedb');
    const id = (await dr.c.post(`/api/patients/${pid}/dental-quotes`, { items: ITEMS })).json().id as string;
    await dr.c.post(`/api/dental-quotes/${id}/present`);
    const run = (sql: string, params: unknown[] = [id]) => withTenant(appPool, t.id, (tx) => tx.query(sql, params));
    await expect(run('UPDATE dental_quotes SET notes = $2 WHERE id = $1', [id, 'alterado'])).rejects.toThrow(/imutável/);
    await expect(run("UPDATE dental_quotes SET status = 'draft', presented_at = NULL WHERE id = $1")).rejects.toThrow();
    await expect(run('DELETE FROM dental_quotes WHERE id = $1')).rejects.toThrow(/excluído|permission denied/);
    await expect(run('UPDATE dental_quote_items SET price_cents = 1 WHERE quote_id = $1')).rejects.toThrow(/imutáveis|permission denied/);
    await expect(run('DELETE FROM dental_quote_items WHERE quote_id = $1')).rejects.toThrow(/imutáveis/);
    await expect(run(
      `INSERT INTO dental_quote_items (tenant_id, quote_id, position, procedure, price_cents) VALUES ($1, $2, 9, 'Extra', 100)`, [t.id, id])).rejects.toThrow(/imutáveis/);
    // aceito também é definitivo
    await dr.c.post(`/api/dental-quotes/${id}/accept`, { acceptedByName: 'Paciente Orçamento', acceptedByRole: 'patient' });
    await expect(run("UPDATE dental_quotes SET status = 'rejected' WHERE id = $1")).rejects.toThrow(/definitivo/);
  });

  it('orçamentos de uma clínica não aparecem nem podem ser decididos por outra; exportação inclui os orçamentos', async () => {
    const a = await setup('quoteiso-a');
    const b = await tenant('quoteiso-b');
    const bdr = await b.mk('professional', 'dr');
    const id = (await a.dr.c.post(`/api/patients/${a.pid}/dental-quotes`, { items: ITEMS })).json().id as string;
    await a.dr.c.post(`/api/dental-quotes/${id}/present`);
    expect((await bdr.c.post(`/api/dental-quotes/${id}/accept`, { acceptedByName: 'Fulano de Tal', acceptedByRole: 'patient' })).statusCode).toBe(404);
    expect((await bdr.c.post(`/api/dental-quotes/${id}/revise`)).statusCode).toBe(404);
    expect((await a.t.owner.get(`/api/patients/${a.pid}/export`)).json().dentalQuotes).toHaveLength(1);
  });
});
