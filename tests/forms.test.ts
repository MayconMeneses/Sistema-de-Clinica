import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAnswers, fieldsSchema, DEFAULT_TEMPLATES } from '../src/modules/forms/schema.js';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { Client, tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const FIELDS = fieldsSchema.parse([
  { id: 'queixa', label: 'Motivo da consulta', type: 'longtext', required: true },
  { id: 'alergia', label: 'Tem alergia?', type: 'yesno', required: true },
  { id: 'cond', label: 'Condições', type: 'multichoice', options: ['Diabetes', 'Asma'] },
  { id: 'dor', label: 'Dor', type: 'scale' },
  { id: 'peso', label: 'Peso', type: 'number', min: 1, max: 400 },
]);

describe('validação de respostas', () => {
  it('aceita respostas válidas e normaliza', () => {
    expect(validateAnswers(FIELDS, { queixa: '  dor  ', alergia: false, cond: ['Asma'], dor: 3 })).toEqual({ queixa: 'dor', alergia: false, cond: ['Asma'], dor: 3 });
  });
  it('recusa campo desconhecido, obrigatório vazio, tipo errado e limites', () => {
    expect(() => validateAnswers(FIELDS, { queixa: 'x', alergia: true, extra: 1 })).toThrow();
    expect(() => validateAnswers(FIELDS, { alergia: true })).toThrow();
    expect(() => validateAnswers(FIELDS, { queixa: 'x', alergia: 'sim' })).toThrow();
    expect(() => validateAnswers(FIELDS, { queixa: 'x', alergia: true, cond: ['Outra'] })).toThrow();
    expect(() => validateAnswers(FIELDS, { queixa: 'x', alergia: true, dor: 11 })).toThrow();
    expect(() => validateAnswers(FIELDS, { queixa: 'x', alergia: true, dor: 2.5 })).toThrow();
    expect(() => validateAnswers(FIELDS, { queixa: 'x', alergia: true, peso: 1e12 })).toThrow();
    expect(() => validateAnswers(FIELDS, { queixa: 'x'.repeat(2001), alergia: true })).toThrow();
    expect(() => validateAnswers(FIELDS, [])).toThrow();
  });
  it('modelos prontos são válidos', () => {
    for (const t of DEFAULT_TEMPLATES) expect(() => fieldsSchema.parse(t.fields), t.key).not.toThrow();
  });
});

async function setup(plan = 'completa') {
  const t = await tenant('forms', plan);
  const dr = await t.mk('professional', 'drfm');
  const rec = await t.mk('receptionist', 'recfm');
  const fin = await t.mk('finance', 'finfm');
  const pid = (await t.owner.post('/api/patients', { name: 'Paciente Forms', birthDate: '1990-05-17' })).json().id as string;
  const tpl = (await t.owner.post('/api/form-templates', { name: 'Anamnese Teste', fields: FIELDS })).json().id as string;
  return { t, dr, rec, fin, pid, tpl };
}
async function portalLogin(t: Awaited<ReturnType<typeof tenant>>, pid: string, birth = '1990-05-17') {
  const inv = (await t.owner.post(`/api/patients/${pid}/portal-invite`)).json() as { link: string };
  const q = new URLSearchParams(new URL(inv.link).hash.split('?')[1]);
  const c = new Client('ps');
  expect((await c.post('/api/portal/login', { clinic: q.get('clinic'), token: q.get('token'), birthDate: birth })).statusCode).toBe(200);
  return c;
}

describe('formulários e triagem', () => {
  it('fluxo: modelo → pedido → paciente responde pelo portal → só o prontuário lê; resposta é imutável', async () => {
    const s = await setup();
    const req = await s.rec.c.post(`/api/patients/${s.pid}/forms`, { templateId: s.tpl });
    expect(req.statusCode).toBe(200);
    const fid = req.json().id as string;
    expect((await s.rec.c.post(`/api/patients/${s.pid}/forms`, { templateId: s.tpl })).statusCode).toBe(409);   // já pendente
    const c = await portalLogin(s.t, s.pid);
    const me = (await c.get('/api/portal/me')).json();
    expect(me.pendingForms.map((f: { id: string }) => f.id)).toEqual([fid]);
    const form = (await c.get(`/api/portal/forms/${fid}`)).json();
    expect(form.fields).toHaveLength(5);
    expect((await c.post(`/api/portal/forms/${fid}/submit`, { answers: { queixa: 'dor', alergia: true, hack: 1 } })).statusCode).toBe(400);
    expect((await c.post(`/api/portal/forms/${fid}/submit`, { answers: { alergia: true } })).statusCode).toBe(400);
    expect((await c.post(`/api/portal/forms/${fid}/submit`, { answers: { queixa: 'dor de dente', alergia: true, cond: ['Asma'] } })).statusCode).toBe(200);
    expect((await c.post(`/api/portal/forms/${fid}/submit`, { answers: { queixa: 'outra', alergia: false } })).statusCode).toBe(404);   // já respondido
    expect((await c.get(`/api/portal/forms/${fid}`)).statusCode).toBe(404);
    expect((await c.get('/api/portal/me')).json().pendingForms).toEqual([]);
    expect(JSON.stringify((await c.get('/api/portal/me')).json())).not.toContain('dor de dente');                 // respostas nunca voltam ao portal

    // quem lê as respostas: owner e profissional. Recepção e financeiro não.
    const asDr = (await s.dr.c.get(`/api/patients/${s.pid}/forms`)).json();
    expect(asDr.forms[0].answers.queixa).toBe('dor de dente');
    const asRec = (await s.rec.c.get(`/api/patients/${s.pid}/forms`)).json();
    expect(asRec.canReadAnswers).toBe(false);
    expect(JSON.stringify(asRec)).not.toContain('dor de dente');
    expect((await s.fin.c.get(`/api/patients/${s.pid}/forms`)).statusCode).toBe(403);
    // staff também não reescreve
    expect((await s.rec.c.post(`/api/forms/${fid}/submit`, { answers: { queixa: 'x', alergia: false } })).statusCode).toBe(409);
    expect((await s.rec.c.post(`/api/forms/${fid}/cancel`)).statusCode).toBe(409);
    // imutável no banco
    await expect(platformPool.query(`UPDATE form_requests SET answers = '{}'::jsonb WHERE id = $1`, [fid])).rejects.toThrow();
    await expect(platformPool.query('DELETE FROM form_requests WHERE id = $1', [fid])).rejects.toThrow();
  });

  it('recepção preenche pelo paciente; cancelar pedido; modelo desativado não é pedido; nova versão preserva a antiga', async () => {
    const s = await setup();
    const fid = (await s.rec.c.post(`/api/patients/${s.pid}/forms`, { templateId: s.tpl })).json().id as string;
    expect((await s.rec.c.post(`/api/forms/${fid}/submit`, { answers: { queixa: 'limpeza', alergia: false } })).statusCode).toBe(200);
    const f2 = (await s.rec.c.post(`/api/patients/${s.pid}/forms`, { templateId: s.tpl })).json().id as string;
    expect((await s.rec.c.post(`/api/forms/${f2}/cancel`)).statusCode).toBe(200);
    // recepção não cria/edita modelos
    expect((await s.rec.c.post('/api/form-templates', { name: 'X1', fields: FIELDS })).statusCode).toBe(403);
    const v2 = await s.t.owner.post('/api/form-templates', { name: 'Anamnese Teste', key: 'anamnese-teste', fields: FIELDS.slice(0, 2) });
    const list = (await s.t.owner.get('/api/form-templates?all=1')).json().templates as { id: string; version: number }[];
    expect(list.find((x) => x.id === v2.json().id)?.version).toBeGreaterThanOrEqual(1);
    expect((await s.t.owner.post(`/api/form-templates/${s.tpl}/active`, { active: false })).statusCode).toBe(200);
    expect((await s.rec.c.post(`/api/patients/${s.pid}/forms`, { templateId: s.tpl })).statusCode).toBe(409);
    expect((await s.t.owner.post('/api/form-templates', { name: 'Ruim', fields: [{ id: 'A', label: 'x', type: 'text' }] })).statusCode).toBe(400);
  });

  it('o portal só enxerga formulário do próprio paciente e de clínica com a capacidade', async () => {
    const s = await setup();
    const other = (await s.t.owner.post('/api/patients', { name: 'Outro Paciente', birthDate: '1985-01-01' })).json().id as string;
    const fid = (await s.rec.c.post(`/api/patients/${s.pid}/forms`, { templateId: s.tpl })).json().id as string;
    const cOther = await portalLogin(s.t, other, '1985-01-01');
    expect((await cOther.get(`/api/portal/forms/${fid}`)).statusCode).toBe(404);
    expect((await cOther.post(`/api/portal/forms/${fid}/submit`, { answers: { queixa: 'x', alergia: true } })).statusCode).toBe(404);
    const o = await setup();
    const cO = await portalLogin(o.t, o.pid);
    expect((await cO.get(`/api/portal/forms/${fid}`)).statusCode).toBe(404);                                     // outra clínica
  });

  it('plano sem formulários: tudo bloqueado', async () => {
    const t = await tenant('forms-solo', 'solo');
    const pid = (await t.owner.post('/api/patients', { name: 'P', birthDate: '1990-01-01' })).json().id as string;
    expect((await t.owner.get('/api/form-templates')).statusCode).toBe(403);
    expect((await t.owner.get(`/api/patients/${pid}/forms`)).statusCode).toBe(403);
    expect((await t.owner.post(`/api/patients/${pid}/triage`, { weightKg: 70 })).statusCode).toBe(403);
  });

  it('triagem: validações, append-only, leitura só do prontuário, aparece na recepção', async () => {
    const s = await setup();
    const post = (body: object) => s.rec.c.post(`/api/patients/${s.pid}/triage`, body);
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ bpSystolic: 120 })).statusCode).toBe(400);
    expect((await post({ bpSystolic: 80, bpDiastolic: 120 })).statusCode).toBe(400);
    expect((await post({ weightKg: -1 })).statusCode).toBe(400);
    expect((await post({ temperatureC: 60 })).statusCode).toBe(400);
    expect((await post({ weightKg: 70, hack: 1 })).statusCode).toBe(400);
    const ok = await post({ weightKg: 70.5, bpSystolic: 120, bpDiastolic: 80, painScale: 4, complaint: 'dor de dente' });
    expect(ok.statusCode).toBe(200);
    expect((await s.fin.c.post(`/api/patients/${s.pid}/triage`, { weightKg: 70 })).statusCode).toBe(403);
    expect((await s.rec.c.get(`/api/patients/${s.pid}/triage`)).statusCode).toBe(403);                           // recepção registra, não lê
    const read = (await s.dr.c.get(`/api/patients/${s.pid}/triage`)).json();
    expect(read.triage).toHaveLength(1);
    expect(read.triage[0].weightKg).toBe(70.5);
    await expect(platformPool.query('UPDATE triage_records SET weight_kg = 1 WHERE id = $1', [ok.json().id])).rejects.toThrow();
    await expect(platformPool.query('DELETE FROM triage_records WHERE id = $1', [ok.json().id])).rejects.toThrow();
  });

  it('isolamento entre clínicas', async () => {
    const a = await setup(), b = await setup();
    const fid = (await a.rec.c.post(`/api/patients/${a.pid}/forms`, { templateId: a.tpl })).json().id as string;
    expect((await b.t.owner.get(`/api/forms/${fid}`)).statusCode).toBe(404);
    expect((await b.t.owner.post(`/api/forms/${fid}/cancel`)).statusCode).toBe(404);
    expect((await b.t.owner.post(`/api/patients/${a.pid}/forms`, { templateId: b.tpl })).statusCode).toBe(404);
    expect((await b.t.owner.post(`/api/patients/${a.pid}/triage`, { weightKg: 70 })).statusCode).toBe(404);
  });
});
