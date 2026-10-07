import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const ymd = (plus = 0) => new Date(Date.now() + plus * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const LEAD = { name: 'Lead Teste', phone: '(11) 98888-7777', source: 'instagram', interest: 'Clareamento' };

async function setup(label = 'crm') {
  const t = await tenant(label);
  const mkt = await t.mk('marketing', 'mkt');
  const rec = await t.mk('receptionist', 'rita');
  return { t, mkt, rec };
}

describe('CRM', () => {
  it('exige o recurso no plano e o perfil certo', async () => {
    const e = await tenant('crmplan', 'essencial');
    expect((await e.owner.get('/api/crm/leads')).json().error).toBe('capability_unavailable');
    const { t, mkt } = await setup('crmrbac');
    const pro = await t.mk('professional', 'dr');
    const aud = await t.mk('auditor', 'aud');
    expect((await pro.c.get('/api/crm/leads')).statusCode).toBe(403);
    expect((await aud.c.get('/api/crm/leads')).statusCode).toBe(403);
    expect((await mkt.c.post('/api/crm/leads', LEAD)).statusCode).toBe(200);
  });

  it('cadastro exige um contato; histórico registra criação, etapas, notas, responsável e consentimento', async () => {
    const { t, mkt, rec } = await setup('crmflow');
    expect((await mkt.c.post('/api/crm/leads', { name: 'Sem contato' })).statusCode).toBe(400);
    expect((await mkt.c.post('/api/crm/leads', { ...LEAD, ownerId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(400);
    const id = (await mkt.c.post('/api/crm/leads', { ...LEAD, marketingConsent: true, nextContactOn: ymd(-1) })).json().id as string;

    expect((await mkt.c.patch(`/api/crm/leads/${id}`, { stage: 'contacted' })).statusCode).toBe(200);
    expect((await mkt.c.post(`/api/crm/leads/${id}/notes`, { note: 'Ligou e pediu orçamento', nextContactOn: ymd(3) })).statusCode).toBe(200);
    const recId = ((await t.owner.get('/api/users')).json().users as { id: string; role: string }[]).find((u) => u.role === 'receptionist')!.id;
    expect((await mkt.c.patch(`/api/crm/leads/${id}`, { ownerId: recId })).statusCode).toBe(200);
    expect((await mkt.c.patch(`/api/crm/leads/${id}`, { marketingConsent: false })).statusCode).toBe(200);
    expect((await mkt.c.patch(`/api/crm/leads/${id}`, { stage: 'lost' })).statusCode).toBe(400); // perda exige motivo
    expect((await mkt.c.patch(`/api/crm/leads/${id}`, { stage: 'lost', lostReason: 'Achou caro' })).statusCode).toBe(200);
    expect((await mkt.c.patch(`/api/crm/leads/${id}`, { stage: 'contacted' })).statusCode).toBe(200); // reabre

    const d = (await rec.c.get(`/api/crm/leads/${id}`)).json();
    expect(d.lead).toMatchObject({ stage: 'contacted', lostReason: null, ownerName: expect.stringContaining('rita'), marketingConsent: false, nextContactOn: ymd(3) });
    expect((d.events as { kind: string }[]).map((e) => e.kind)).toEqual(['created', 'consent', 'stage', 'note', 'assigned', 'consent', 'stage', 'stage']);
    expect((d.events as { authorName: string }[]).every((e) => e.authorName)).toBe(true);
  });

  it('lista por etapa com contagens e pendentes de contato', async () => {
    const { mkt } = await setup('crmlist');
    const a = (await mkt.c.post('/api/crm/leads', { ...LEAD, name: 'Lead Atrasado', nextContactOn: ymd(-2) })).json().id as string;
    await mkt.c.post('/api/crm/leads', { ...LEAD, name: 'Lead Futuro', nextContactOn: ymd(5) });
    await mkt.c.post('/api/crm/leads', { name: 'Lead Email', email: 'lead@exemplo.com' });
    await mkt.c.patch(`/api/crm/leads/${a}`, { stage: 'scheduled' });
    const all = (await mkt.c.get('/api/crm/leads')).json();
    expect(all.counts).toEqual({ new: 2, contacted: 0, scheduled: 1, won: 0, lost: 0 });
    expect(all.dueCount).toBe(1);
    expect(((await mkt.c.get('/api/crm/leads?due=1')).json().leads as { name: string }[]).map((l) => l.name)).toEqual(['Lead Atrasado']);
    expect(((await mkt.c.get('/api/crm/leads?stage=scheduled')).json().leads as unknown[]).length).toBe(1);
    expect(((await mkt.c.get('/api/crm/leads?q=email')).json().leads as unknown[]).length).toBe(1);
  });

  it('conversão: exige permissão de cadastrar paciente; avisa duplicidade; liga a existente; só converte uma vez', async () => {
    const { t, mkt, rec } = await setup('crmconv');
    const existing = (await t.owner.post('/api/patients', { name: 'Lead Teste Silva', phone: '11988887777' })).json().id as string;
    const id = (await mkt.c.post('/api/crm/leads', LEAD)).json().id as string;

    expect((await mkt.c.post(`/api/crm/leads/${id}/convert`, {})).statusCode).toBe(403); // marketing não cadastra paciente
    const dup = await rec.c.post(`/api/crm/leads/${id}/convert`, {});
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('possible_duplicate');
    expect(dup.json().candidates.map((c: { id: string }) => c.id)).toContain(existing);

    const linked = await rec.c.post(`/api/crm/leads/${id}/convert`, { patientId: existing });
    expect(linked.json().patientId).toBe(existing);
    expect((await rec.c.get(`/api/crm/leads/${id}`)).json().lead).toMatchObject({ stage: 'won', patientId: existing });
    expect((await rec.c.post(`/api/crm/leads/${id}/convert`, {})).statusCode).toBe(409);
    expect((await mkt.c.patch(`/api/crm/leads/${id}`, { stage: 'lost', lostReason: 'Tentativa' })).statusCode).toBe(409); // ganho não volta

    // sem duplicidade: cria o paciente novo
    const id2 = (await mkt.c.post('/api/crm/leads', { name: 'Pessoa Inédita Unica', email: 'unica@exemplo.com' })).json().id as string;
    const created = (await rec.c.post(`/api/crm/leads/${id2}/convert`, {})).json().patientId as string;
    expect(((await rec.c.get('/api/patients?q=Inédita')).json().patients as { id: string }[]).map((p) => p.id)).toContain(created);
  });

  it('o banco protege o histórico e a regra de "ganho"; leads não vazam entre clínicas', async () => {
    const a = await setup('crmdb-a');
    const b = await setup('crmdb-b');
    const id = (await a.mkt.c.post('/api/crm/leads', LEAD)).json().id as string;
    expect((await b.mkt.c.get(`/api/crm/leads/${id}`)).statusCode).toBe(404);
    expect((await b.mkt.c.patch(`/api/crm/leads/${id}`, { stage: 'contacted' })).statusCode).toBe(404);
    expect((await b.rec.c.post(`/api/crm/leads/${id}/convert`, {})).statusCode).toBe(404);
    expect(((await b.mkt.c.get('/api/crm/leads')).json().leads as unknown[]).length).toBe(0);

    const run = (sql: string) => withTenant(appPool, a.t.id, (tx) => tx.query(sql));
    await expect(run('UPDATE crm_lead_events SET note = $$x$$')).rejects.toThrow(/permission denied|append-only/);
    await expect(run('DELETE FROM crm_lead_events')).rejects.toThrow(/permission denied|append-only/);
    await expect(run('DELETE FROM crm_leads')).rejects.toThrow(/permission denied|excluído/);
    await expect(run("UPDATE crm_leads SET stage = 'won'")).rejects.toThrow(/crm_leads_check|check/i); // ganho sem paciente
  });
});
