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

describe('agendar direto do lead', () => {
  async function ready(label: string) {
    const { t, mkt, rec } = await setup(label);
    await t.mk('professional', 'dra');
    const proId = ((await t.owner.get('/api/professionals')).json().professionals as { id: string }[])[0]!.id;
    let n = 0;
    const slot = () => ({ startsAt: new Date(Date.UTC(2032, 6, 1, 12 + n, 0)).toISOString(), endsAt: new Date(Date.UTC(2032, 6, 1, 13 + n++, 0)).toISOString() });
    const book = (leadId: string, extra: object = {}, who = t.owner) => who.post(`/api/crm/leads/${leadId}/schedule`, { professionalId: proId, service: 'Avaliação', encaixe: true, ...slot(), ...extra });
    const lead = async (name: string, phone: string) => (await t.owner.post('/api/crm/leads', { ...LEAD, name, phone })).json().id as string;
    return { t, mkt, rec, proId, book, lead, slot };
  }

  it('converte em paciente, marca a consulta e fecha o lead como ganho', async () => {
    const { t, book, lead } = await ready('crmsched');
    const id = await lead('Lead Agenda Direta', '(11) 97777-1111');
    const r = await book(id);
    expect(r.statusCode).toBe(200);
    const { patientId, appointmentId } = r.json();
    const l = (await t.owner.get(`/api/crm/leads/${id}`)).json();
    expect(l.lead).toMatchObject({ stage: 'won', patientId });
    expect((l.events as { kind: string; note: string | null }[]).map((e) => e.kind)).toEqual(expect.arrayContaining(['converted', 'note']));
    expect(JSON.stringify(l.events)).toContain('Consulta agendada para');
    const appts = (await t.owner.get('/api/appointments?from=2032-06-30T00:00:00Z&to=2032-07-03T00:00:00Z')).json().appointments as { id: string; patientId: string; service: string }[];
    expect(appts.find((a) => a.id === appointmentId)).toMatchObject({ patientId, service: 'Avaliação' });
    // lead já convertido: nova consulta para o mesmo paciente, sem cadastrar de novo
    const again = await book(id);
    expect(again.statusCode).toBe(200);
    expect(again.json().patientId).toBe(patientId);
  });

  it('é tudo ou nada: conflito de horário não deixa paciente nem lead convertido; duplicidade pede confirmação', async () => {
    const { t, book, lead, slot } = await ready('crmschedatomic');
    const fixed = slot();
    const a = await lead('Primeiro Lead', '(11) 97777-2222');
    expect((await book(a, fixed)).statusCode).toBe(200);
    const b = await lead('Segundo Lead', '(11) 97777-3333');
    const clash = await book(b, fixed);                       // mesmo profissional e horário
    expect(clash.statusCode).toBe(409);
    const lb = (await t.owner.get(`/api/crm/leads/${b}`)).json().lead;
    expect(lb).toMatchObject({ stage: 'new', patientId: null });
    expect((await t.owner.get('/api/patients?q=Segundo%20Lead')).json().patients).toHaveLength(0);

    // nome e telefone iguais a um paciente existente: pede confirmação
    const dup = await lead('Primeiro Lead', '(11) 97777-2222');
    const d1 = await book(dup);
    expect(d1.statusCode).toBe(409);
    expect(d1.json().error).toBe('possible_duplicate');
    expect((await book(dup, { confirmNotDuplicate: true })).statusCode).toBe(200);
  });

  it('perfil: marketing não agenda; recepção sim; horário inválido é recusado', async () => {
    const { t, mkt, rec, book, lead } = await ready('crmschedrbac');
    const id = await lead('Lead Perfil', '(11) 97777-4444');
    expect((await book(id, {}, mkt.c)).statusCode).toBe(403);
    expect((await book(id, { startsAt: '2032-07-01T15:00:00Z', endsAt: '2032-07-01T14:00:00Z' })).statusCode).toBe(400);
    expect((await book(id, {}, rec.c)).statusCode).toBe(200);
    expect((await t.owner.post('/api/crm/leads/00000000-0000-4000-8000-000000000000/schedule', { professionalId: '00000000-0000-4000-8000-000000000000', startsAt: '2032-07-01T15:00:00Z', endsAt: '2032-07-01T16:00:00Z' })).statusCode).toBe(404);
  });
});
