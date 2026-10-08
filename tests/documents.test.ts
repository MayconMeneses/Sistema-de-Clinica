import type { FastifyInstance } from 'fastify';
import { withTenant } from '../src/db/tenant.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('conteudo do exame'), Buffer.from('\n%%EOF')]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const upload = (c: { post: (u: string, b?: unknown) => Promise<{ statusCode: number; json: () => any }> }, pid: string, buf: Buffer, extra: object = {}) =>
  c.post(`/api/patients/${pid}/documents`, { title: 'Radiografia panorâmica', category: 'other', fileName: 'radio.pdf', contentBase64: buf.toString('base64'), ...extra });

describe('anexos e documentos do paciente', () => {
  it('envia, lista sem o conteúdo, baixa idêntico e registra no histórico; arquivar exige motivo e some da lista', async () => {
    const t = await tenant('docs');
    const rec = await t.mk('receptionist', 'rec');
    const pid = (await rec.c.post('/api/patients', { name: 'Paciente Doc' })).json().id as string;
    const up = await upload(rec.c, pid, pdf);
    expect(up.statusCode).toBe(200);
    const id = up.json().id as string;
    expect((await upload(rec.c, pid, png, { title: 'Foto do documento', category: 'identity', fileName: 'rg.png' })).statusCode).toBe(200);
    const list = (await rec.c.get(`/api/patients/${pid}/documents`)).json().documents as { id: string; mimeType: string; sizeBytes: number; content?: unknown }[];
    expect(list).toHaveLength(2);
    expect(list.find((d) => d.id === id)).toMatchObject({ mimeType: 'application/pdf', sizeBytes: pdf.length });
    expect(JSON.stringify(list)).not.toContain('contentBase64');
    const raw = await rec.c.req('GET', `/api/documents/${id}/download`);
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toBe('application/pdf');
    expect(raw.headers['content-disposition']).toContain('attachment');
    expect(raw.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(raw.rawPayload).equals(pdf)).toBe(true);
    const ev = await withTenant(appPool, t.id, (tx) => tx.query(`SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY occurred_at`, [id]));
    expect(ev.rows.map((r) => r.action)).toEqual(['document.create', 'document.read']);

    expect((await rec.c.post(`/api/documents/${id}/archive`, { reason: 'x' })).statusCode).toBe(400);
    expect((await rec.c.post(`/api/documents/${id}/archive`, { reason: 'Enviado no paciente errado' })).statusCode).toBe(200);
    expect((await rec.c.post(`/api/documents/${id}/archive`, { reason: 'Enviado no paciente errado' })).statusCode).toBe(409);
    expect((await rec.c.get(`/api/patients/${pid}/documents`)).json().documents).toHaveLength(1);
    expect((await rec.c.get(`/api/patients/${pid}/documents?includeArchived=1`)).json().documents).toHaveLength(2);
    expect((await rec.c.req('GET', `/api/documents/${id}/download`)).statusCode).toBe(200); // arquivado continua guardado
  });

  it('recusa tipo falso, arquivo vazio, base64 inválido e arquivo grande; o tipo vem do conteúdo, não do nome', async () => {
    const t = await tenant('docsbad');
    const dr = await t.mk('professional', 'dr');
    const pid = (await dr.c.post('/api/patients', { name: 'Paciente Doc2' })).json().id as string;
    expect((await upload(dr.c, pid, Buffer.from('MZ\x90\x00 executavel'), { fileName: 'laudo.pdf' })).statusCode).toBe(400);
    expect((await upload(dr.c, pid, Buffer.from('<html><script>alert(1)</script>'), { fileName: 'a.png' })).statusCode).toBe(400);
    expect((await dr.c.post(`/api/patients/${pid}/documents`, { title: 'Vazio', category: 'other', fileName: 'v.pdf', contentBase64: '' })).statusCode).toBe(400);
    expect((await dr.c.post(`/api/patients/${pid}/documents`, { title: 'Ruim', category: 'other', fileName: 'v.pdf', contentBase64: '%%%%' })).statusCode).toBe(400);
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024)]);
    expect((await upload(dr.c, pid, big)).statusCode).toBe(413);
    const ok = await upload(dr.c, pid, pdf, { fileName: '../../etc/pa"ss\r\nwd.pdf' });
    expect(ok.statusCode).toBe(200);
    const l = (await dr.c.get(`/api/patients/${pid}/documents`)).json().documents[0];
    expect(l.fileName).not.toMatch(/[\/"\r\n\\]/);
    // um corpo grande em outra rota continua limitado a 256 KB
    expect((await dr.c.post('/api/patients', { name: 'x'.repeat(300_000) })).statusCode).toBe(413);
  });

  it('isolamento entre clínicas, papéis sem acesso e paciente de outra clínica; o banco bloqueia alterar e excluir', async () => {
    const a = await tenant('docsa');
    const b = await tenant('docsb');
    const pid = (await a.owner.post('/api/patients', { name: 'Paciente A' })).json().id as string;
    const id = (await upload(a.owner, pid, pdf)).json().id as string;
    expect((await b.owner.req('GET', `/api/documents/${id}/download`)).statusCode).toBe(404);
    expect((await b.owner.post(`/api/documents/${id}/archive`, { reason: 'Tentativa indevida' })).statusCode).toBe(404);
    expect((await upload(b.owner, pid, pdf)).statusCode).toBeGreaterThanOrEqual(400);
    const fin = await a.mk('finance', 'fin');
    expect((await fin.c.get(`/api/patients/${pid}/documents`)).statusCode).toBe(403);
    expect((await upload(fin.c, pid, pdf)).statusCode).toBe(403);
    await expect(withTenant(appPool, a.id, (tx) => tx.query('DELETE FROM patient_documents WHERE id = $1', [id]))).rejects.toThrow(/permission denied/);
    await expect(withTenant(appPool, a.id, (tx) => tx.query("UPDATE patient_documents SET title = 'Outro' WHERE id = $1", [id]))).rejects.toThrow(/imutável/);
  });

  it('exames e laudos seguem a segregação do prontuário: recepção não anexa, não lista, não baixa e não arquiva', async () => {
    const t = await tenant('docsseg');
    const dr = await t.mk('professional', 'drseg');
    const rec = await t.mk('receptionist', 'recseg');
    const pid = (await dr.c.post('/api/patients', { name: 'Paciente Seg' })).json().id as string;
    const exam = (await upload(dr.c, pid, pdf, { category: 'exam', title: 'Panorâmica' })).json().id as string;
    const termo = (await upload(rec.c, pid, pdf, { category: 'consent', title: 'Termo assinado' })).json().id as string;
    expect((await upload(rec.c, pid, pdf, { category: 'report' })).statusCode).toBe(403);
    expect((await upload(rec.c, pid, pdf, { category: 'exam' })).statusCode).toBe(403);
    const seen = (await rec.c.get(`/api/patients/${pid}/documents`)).json().documents as { id: string }[];
    expect(seen.map((d) => d.id)).toEqual([termo]);
    expect((await rec.c.req('GET', `/api/documents/${exam}/download`)).statusCode).toBe(404);
    expect((await rec.c.post(`/api/documents/${exam}/archive`, { reason: 'Tentativa indevida' })).statusCode).toBe(404);
    expect((await rec.c.req('GET', `/api/documents/${termo}/download`)).statusCode).toBe(200);
    // quem tem acesso ao prontuário vê tudo; o dono também
    expect(((await dr.c.get(`/api/patients/${pid}/documents`)).json().documents as unknown[]).length).toBe(2);
    expect(((await t.owner.get(`/api/patients/${pid}/documents`)).json().documents as unknown[]).length).toBe(2);
    expect((await dr.c.req('GET', `/api/documents/${exam}/download`)).statusCode).toBe(200);
  });
});
