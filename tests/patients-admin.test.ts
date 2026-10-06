import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { buildApp } = await import('../src/server/app.js');
const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); state.app = app; });
afterAll(async () => { await app.close(); await appPool.end(); await platformPool.end(); await workerPool.end(); });

const at = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00-03:00`).toISOString();
const plus = (iso: string, min: number) => new Date(new Date(iso).getTime() + min * 60000).toISOString();

async function clinic(plan = 'completa') {
  const t = await tenant('pat', plan);
  const dr = await t.mk('professional', 'dr');
  const rec = await t.mk('receptionist', 'rita');
  const adm = await t.mk('admin', 'ana');
  const proId = ((await t.owner.get('/api/professionals')).json().professionals as { id: string }[])[0]!.id;
  const create = (b: object, force = true) => t.owner.post('/api/patients', { ...b, ...(force ? { confirmNotDuplicate: true } : {}) });
  const mk = async (name: string, extra: object = {}) => (await create({ name, ...extra })).json().id as string;
  return { t, dr, rec, adm, proId, create, mk };
}

describe('detecção de duplicidade no cadastro', () => {
  it('avisa por documento, por nome+nascimento e por telefone+primeiro nome; "confirmar" permite criar', async () => {
    const c = await clinic();
    const orig = await c.mk('Maria da Conceição', { document: '123.456.789-00', birthDate: '1990-05-10', phone: '(11) 98888-7777' });

    const byDoc = await c.create({ name: 'Maria C. Silva', document: '12345678900' }, false);
    expect(byDoc.statusCode).toBe(409);
    expect(byDoc.json().error).toBe('possible_duplicate');
    expect(byDoc.json().candidates[0]).toMatchObject({ id: orig, reason: 'mesmo documento' });

    const byName = await c.create({ name: 'MARIA DA CONCEICAO', birthDate: '1990-05-10' }, false);   // sem acento e em caixa alta
    expect(byName.statusCode).toBe(409);
    expect(byName.json().candidates[0].reason).toBe('mesmo nome e nascimento');

    const byPhone = await c.create({ name: 'Maria Souza', phone: '+55 11 98888-7777' }, false);
    expect(byPhone.statusCode).toBe(409);
    expect(byPhone.json().candidates[0].reason).toBe('mesmo telefone e primeiro nome');

    expect((await c.create({ name: 'João Diferente', phone: '(11) 98888-7777' }, false)).statusCode).toBe(200);   // outro primeiro nome: não é suspeito
    expect((await c.create({ name: 'Maria C. Silva', document: '12345678900' }, true)).statusCode).toBe(200);     // confirmado pela recepção
  });

  it('atualizar nome/documento mantém as chaves de comparação em dia', async () => {
    const c = await clinic();
    const id = await c.mk('Carlos Antigo');
    await c.t.owner.patch(`/api/patients/${id}`, { name: 'Carlos Novo', document: '987.654.321-00' });
    const dup = await c.create({ name: 'Outro Nome', document: '98765432100' }, false);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().candidates[0].id).toBe(id);
  });

  it('fila de revisão lista os pares; "não é duplicado" tira da fila; só dono/admin', async () => {
    const c = await clinic();
    const a = await c.mk('Ana Teste', { document: '111.222.333-44' });
    const b = await c.mk('Ana T. Souza', { document: '11122233344' });
    expect((await c.rec.c.get('/api/patients/duplicates')).statusCode).toBe(403);
    const list = (await c.adm.c.get('/api/patients/duplicates')).json().pairs as { aId: string; bId: string; reason: string }[];
    expect(list).toHaveLength(1);
    expect([list[0]!.aId, list[0]!.bId].sort()).toEqual([a, b].sort());
    expect((await c.rec.c.post('/api/patients/duplicates/dismiss', { aId: a, bId: b })).statusCode).toBe(403);
    expect((await c.adm.c.post('/api/patients/duplicates/dismiss', { aId: b, bId: a })).statusCode).toBe(200);   // ordem não importa
    expect(((await c.adm.c.get('/api/patients/duplicates')).json().pairs as unknown[]).length).toBe(0);
    expect((await c.adm.c.post('/api/patients/duplicates/dismiss', { aId: a, bId: a })).statusCode).toBe(400);
  });
});

describe('mesclagem auditada', () => {
  it('histórico imutável continua visível no cadastro principal; cadastro de origem sai das listas e não aceita novos registros', async () => {
    const c = await clinic();
    const src = await c.mk('Paciente Origem', { phone: '(11) 97777-1111', email: 'origem@exemplo.com', birthDate: '1985-02-02' });
    const tgt = await c.mk('Paciente Principal');
    // histórico no cadastro de origem: nota assinada, cobrança, achado dental, consulta
    const nid = (await c.dr.c.post(`/api/patients/${src}/notes`, { body: 'Evolução antiga (origem)' })).json().id as string;
    await c.dr.c.post(`/api/notes/${nid}/sign`);
    await c.t.owner.post('/api/finance/movements', { patientId: src, kind: 'charge', amountCents: 10000 });
    await c.dr.c.post(`/api/patients/${src}/odontogram/findings`, { tooth: '16', surface: 'O', condition: 'caries' });
    const appt = await c.t.owner.post('/api/appointments', { patientId: src, professionalId: c.proId, startsAt: at('2031-08-04', '10:00'), endsAt: at('2031-08-04', '10:30') });
    expect(appt.statusCode).toBe(200);
    // histórico no principal
    await c.t.owner.post('/api/finance/movements', { patientId: tgt, kind: 'charge', amountCents: 2500 });

    expect((await c.rec.c.post(`/api/patients/${src}/merge`, { intoId: tgt, reason: 'cadastro repetido' })).statusCode).toBe(403);
    const m = await c.adm.c.post(`/api/patients/${src}/merge`, { intoId: tgt, reason: 'cadastro repetido na recepção' });
    expect(m.statusCode).toBe(200);
    expect((m.json().copied as string[]).sort()).toEqual(['birth_date', 'email', 'phone']);

    // principal passa a mostrar tudo
    const notes = (await c.dr.c.get(`/api/patients/${tgt}/notes`)).json().notes as { body: string }[];
    expect(notes.map((n) => n.body)).toContain('Evolução antiga (origem)');
    const fin = (await c.t.owner.get(`/api/patients/${tgt}/finance`)).json();
    expect(fin.balanceCents).toBe('12500');
    const odo = (await c.dr.c.get(`/api/patients/${tgt}/odontogram`)).json().findings as { tooth: string }[];
    expect(odo.map((f) => f.tooth)).toContain('16');
    const day = (await c.t.owner.get(`/api/appointments?from=${encodeURIComponent(at('2031-08-04', '00:00'))}&to=${encodeURIComponent(at('2031-08-05', '00:00'))}`)).json().appointments as { patientId: string }[];
    expect(day[0]!.patientId).toBe(tgt);                           // consulta foi para o principal
    const principal = (await c.t.owner.get(`/api/patients/${tgt}`)).json().patient;
    expect(principal).toMatchObject({ phone: '(11) 97777-1111', email: 'origem@exemplo.com', birthDate: '1985-02-02' });   // contatos herdados

    // origem: alias
    const old = (await c.t.owner.get(`/api/patients/${src}`)).json().patient;
    expect(old.mergedInto).toBe(tgt);
    const search = (await c.t.owner.get('/api/patients?q=Paciente')).json().patients as { id: string }[];
    expect(search.map((p) => p.id)).toEqual([tgt]);
    expect((await c.dr.c.post(`/api/patients/${src}/notes`, { body: 'Novo na origem' })).statusCode).toBe(409);
    expect((await c.t.owner.post('/api/finance/movements', { patientId: src, kind: 'charge', amountCents: 100 })).statusCode).toBe(409);
    expect((await c.t.owner.post('/api/appointments', { patientId: src, professionalId: c.proId, startsAt: at('2031-08-05', '10:00'), endsAt: at('2031-08-05', '10:30') })).statusCode).toBe(409);
    // a nota assinada continua assinada e intacta no banco
    expect((await c.dr.c.patch(`/api/notes/${nid}`, { body: 'reescrita' })).statusCode).toBe(409);

    // auditoria + registro da mesclagem
    const audit = (await c.t.owner.get('/api/audit')).json().events as { action: string }[];
    expect(audit.some((e) => e.action === 'patient.merge')).toBe(true);
  });

  it('mesclagens encadeadas: o principal final enxerga todo o histórico', async () => {
    const c = await clinic();
    const a = await c.mk('Cadastro A'); const b = await c.mk('Cadastro B'); const d = await c.mk('Cadastro D');
    await c.t.owner.post('/api/finance/movements', { patientId: a, kind: 'charge', amountCents: 100 });
    await c.t.owner.post('/api/finance/movements', { patientId: b, kind: 'charge', amountCents: 200 });
    await c.t.owner.post('/api/finance/movements', { patientId: d, kind: 'charge', amountCents: 400 });
    expect((await c.t.owner.post(`/api/patients/${a}/merge`, { intoId: b, reason: 'A repetido de B' })).statusCode).toBe(200);
    expect((await c.t.owner.post(`/api/patients/${b}/merge`, { intoId: d, reason: 'B repetido de D' })).statusCode).toBe(200);
    expect((await c.t.owner.get(`/api/patients/${d}/finance`)).json().balanceCents).toBe('700');
    expect((await c.t.owner.get(`/api/patients/${a}`)).json().patient.mergedInto).toBe(d);   // A passa a apontar para o principal final
  });

  it('validações: motivo, si mesmo, já mesclado, outra clínica; conflito de horário não deixa nada pela metade', async () => {
    const c = await clinic(); const other = await clinic();
    const a = await c.mk('Valida A'); const b = await c.mk('Valida B'); const foreign = await other.mk('Alheio');
    expect((await c.t.owner.post(`/api/patients/${a}/merge`, { intoId: b, reason: 'x' })).statusCode).toBe(400);
    expect((await c.t.owner.post(`/api/patients/${a}/merge`, { intoId: a, reason: 'mesmo cadastro' })).statusCode).toBe(400);
    expect((await c.t.owner.post(`/api/patients/${a}/merge`, { intoId: foreign, reason: 'outra clínica' })).statusCode).toBe(404);
    // conflito: os dois têm consulta no mesmo horário
    const slot = at('2031-08-11', '09:00');
    await c.t.owner.post('/api/appointments', { patientId: a, professionalId: c.proId, startsAt: slot, endsAt: plus(slot, 30) });
    await c.t.mk('professional', 'dra');
    const proB = ((await c.t.owner.get('/api/professionals')).json().professionals as { id: string }[]).map((p) => p.id).find((x) => x !== c.proId)!;
    expect((await c.t.owner.post('/api/appointments', { patientId: b, professionalId: proB, startsAt: slot, endsAt: plus(slot, 30) })).statusCode).toBe(200);
    const clash = await c.t.owner.post(`/api/patients/${a}/merge`, { intoId: b, reason: 'cadastro repetido' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().message).toMatch(/sobrepõem/);
    expect((await c.t.owner.get(`/api/patients/${a}`)).json().patient.mergedInto).toBeNull();   // nada mudou
    // já mesclado
    const e = await c.mk('Valida E');
    expect((await c.t.owner.post(`/api/patients/${e}/merge`, { intoId: b, reason: 'repetido de B' })).statusCode).toBe(200);
    expect((await c.t.owner.post(`/api/patients/${e}/merge`, { intoId: a, reason: 'outra tentativa' })).statusCode).toBe(409);
    expect((await c.t.owner.post(`/api/patients/${a}/merge`, { intoId: e, reason: 'para um já mesclado' })).statusCode).toBe(409);
  });
});

describe('responsáveis', () => {
  it('adiciona, lista (responsável legal primeiro), encerra sem apagar e isola por clínica', async () => {
    const c = await clinic(); const other = await clinic();
    const kid = await c.mk('Criança Teste', { birthDate: '2018-03-03' });
    expect((await c.rec.c.post(`/api/patients/${kid}/guardians`, { name: 'Tia', relationship: 'Tia', phone: '(11) 90000-0000' })).statusCode).toBe(200);
    const mom = await c.rec.c.post(`/api/patients/${kid}/guardians`, { name: 'Mãe da Criança', relationship: 'Mãe', legalGuardian: true, email: 'mae@exemplo.com' });
    expect(mom.statusCode).toBe(200);
    const list = (await c.rec.c.get(`/api/patients/${kid}/guardians`)).json().guardians as { name: string; legalGuardian: boolean }[];
    expect(list.map((g) => g.name)).toEqual(['Mãe da Criança', 'Tia']);
    expect((await c.rec.c.post(`/api/patients/${kid}/guardians`, { name: 'X', relationship: 'Mãe' })).statusCode).toBe(400);
    expect((await c.rec.c.post(`/api/patients/${kid}/guardians`, { name: 'Fulana', relationship: 'Mãe', email: 'invalido' })).statusCode).toBe(400);
    const selfRef = await c.rec.c.post(`/api/patients/${kid}/guardians`, { name: 'Ela Mesma', relationship: 'Outro', guardianPatientId: kid });
    expect(selfRef.statusCode).toBe(400);                               // paciente não é responsável de si mesmo (CHECK)
    expect((await c.rec.c.del(`/api/patients/${kid}/guardians/${mom.json().id}`)).statusCode).toBe(200);
    expect((await c.rec.c.del(`/api/patients/${kid}/guardians/${mom.json().id}`)).statusCode).toBe(404);
    expect(((await c.rec.c.get(`/api/patients/${kid}/guardians`)).json().guardians as unknown[]).length).toBe(1);
    expect(((await other.t.owner.get(`/api/patients/${kid}/guardians`)).json().guardians as unknown[]).length).toBe(0);
  });
});

describe('solicitações de privacidade', () => {
  it('recepção abre; só dono/admin resolve; prazo de 15 dias; resolvida é imutável; painel mostra pendências', async () => {
    const c = await clinic(); const other = await clinic();
    const p = await c.mk('Titular Dados');
    const opened = await c.rec.c.post(`/api/patients/${p}/privacy`, { kind: 'export', details: 'Paciente pediu cópia dos dados' });
    expect(opened.statusCode).toBe(200);
    const due = new Date(opened.json().dueAt).getTime() - Date.now();
    expect(due).toBeGreaterThan(14 * 86400_000); expect(due).toBeLessThan(16 * 86400_000);
    expect((await c.dr.c.post(`/api/patients/${p}/privacy`, { kind: 'access' })).statusCode).toBe(403);
    expect((await c.rec.c.get('/api/privacy/requests')).statusCode).toBe(403);
    const dash = (await c.adm.c.get('/api/dashboard')).json();
    expect(dash.privacyOpen).toBe(1);
    const id = opened.json().id as string;
    expect((await c.rec.c.patch(`/api/privacy/requests/${id}`, { status: 'in_progress' })).statusCode).toBe(403);
    expect((await c.adm.c.patch(`/api/privacy/requests/${id}`, { status: 'done' })).statusCode).toBe(400);              // exige resposta
    expect((await c.adm.c.patch(`/api/privacy/requests/${id}`, { status: 'in_progress' })).statusCode).toBe(200);
    expect((await c.adm.c.patch(`/api/privacy/requests/${id}`, { status: 'done', resolution: 'Cópia entregue ao titular em mãos' })).statusCode).toBe(200);
    expect((await c.adm.c.patch(`/api/privacy/requests/${id}`, { status: 'rejected', resolution: 'tentativa tardia' })).statusCode).toBe(409);
    const hist = (await c.rec.c.get(`/api/patients/${p}/privacy`)).json().requests as { status: string; resolution: string }[];
    expect(hist[0]).toMatchObject({ status: 'done', resolution: 'Cópia entregue ao titular em mãos' });
    expect(((await c.adm.c.get('/api/privacy/requests')).json().requests as unknown[]).length).toBe(0);
    expect(((await other.t.owner.get('/api/privacy/requests')).json().requests as unknown[]).length).toBe(0);
    expect((await other.t.owner.post(`/api/patients/${p}/privacy`, { kind: 'access' })).statusCode).toBe(400);          // paciente de outra clínica
  });

  it('pedido de exclusão é registrado, mas nada é apagado (retenção a decidir com o jurídico)', async () => {
    const c = await clinic();
    const p = await c.mk('Quer Apagar');
    const r = await c.adm.c.post(`/api/patients/${p}/privacy`, { kind: 'deletion', details: 'Solicitou exclusão' });
    expect(r.statusCode).toBe(200);
    await c.adm.c.patch(`/api/privacy/requests/${r.json().id}`, { status: 'rejected', resolution: 'Prontuário deve ser mantido por obrigação legal; dados de marketing removidos' });
    expect((await c.t.owner.get(`/api/patients/${p}`)).statusCode).toBe(200);                                             // cadastro segue existindo
  });
});

describe('exportação dos dados do paciente', () => {
  it('dono recebe tudo; administrador recebe sem prontuário (e a omissão é informada); profissional não exporta; auditado', async () => {
    const c = await clinic();
    const p = await c.mk('Paciente Export', { phone: '(11) 96666-5555' });
    const nid = (await c.dr.c.post(`/api/patients/${p}/notes`, { body: 'Texto clínico confidencial' })).json().id as string;
    await c.dr.c.post(`/api/notes/${nid}/sign`);
    await c.t.owner.post('/api/finance/movements', { patientId: p, kind: 'charge', amountCents: 5000 });
    await c.dr.c.post(`/api/patients/${p}/odontogram/findings`, { tooth: '21', condition: 'implant' });
    await c.t.owner.post(`/api/patients/${p}/consents`, { purpose: 'communication_email', granted: true });
    await c.rec.c.post(`/api/patients/${p}/guardians`, { name: 'Responsável', relationship: 'Pai' });

    const owner = (await c.t.owner.get(`/api/patients/${p}/export`)).json();
    expect(owner.format).toBe('clinica-one/export/v1');
    expect(owner.records[0].name).toBe('Paciente Export');
    expect(owner.clinicalNotes[0].body).toBe('Texto clínico confidencial');
    expect(owner.finance[0]).toMatchObject({ kind: 'charge', amountCents: '5000' });
    expect(owner.dentalFindings[0]).toMatchObject({ tooth: '21', condition: 'implant' });
    expect(owner.consents[0]).toMatchObject({ purpose: 'communication_email', granted: true });
    expect(owner.guardians[0].name).toBe('Responsável');
    expect((owner.omitted as { section: string }[]).map((o) => o.section)).not.toContain('clinicalNotes');   // dono lê tudo o que contratou
    expect(JSON.stringify(owner)).not.toMatch(/password|token|totp/i);

    const adm = (await c.adm.c.get(`/api/patients/${p}/export`)).json();
    expect(adm.clinicalNotes).toBeUndefined();
    expect(adm.dentalFindings).toBeUndefined();
    expect((adm.omitted as { section: string }[]).map((o) => o.section)).toEqual(expect.arrayContaining(['clinicalNotes', 'dentalFindings', 'dentalPlan']));
    expect(adm.finance).toHaveLength(1);
    expect(JSON.stringify(adm)).not.toContain('Texto clínico confidencial');

    expect((await c.dr.c.get(`/api/patients/${p}/export`)).statusCode).toBe(403);
    expect((await c.rec.c.get(`/api/patients/${p}/export`)).statusCode).toBe(403);
    const events = (await c.t.owner.get('/api/audit')).json().events as { action: string }[];
    expect(events.filter((e) => e.action === 'patient.export')).toHaveLength(2);
  });

  it('inclui o histórico dos cadastros mesclados; paciente de outra clínica é inexistente; plano sem odontologia omite a seção', async () => {
    const c = await clinic(); const other = await clinic();
    const a = await c.mk('Export Origem'); const b = await c.mk('Export Principal');
    await c.t.owner.post('/api/finance/movements', { patientId: a, kind: 'charge', amountCents: 700 });
    await c.t.owner.post(`/api/patients/${a}/merge`, { intoId: b, reason: 'cadastro repetido' });
    const ex = (await c.t.owner.get(`/api/patients/${b}/export`)).json();
    expect(ex.records).toHaveLength(2);
    expect(ex.finance[0].amountCents).toBe('700');
    expect(ex.merges).toHaveLength(1);
    expect((await other.t.owner.get(`/api/patients/${b}/export`)).statusCode).toBe(404);

    const solo = await clinic('solo');
    const sp = await solo.mk('Solo Export');
    const sex = (await solo.t.owner.get(`/api/patients/${sp}/export`)).json();
    expect((sex.omitted as { section: string; reason: string }[]).find((o) => o.section === 'dentalFindings')!.reason).toMatch(/não contratado/);
  });
});

describe('chaves de comparação (mantidas pelo banco)', () => {
  const key = async (fn: string, v: string | null) => (await appPool.query<{ k: string }>(`SELECT ${fn}($1) AS k`, [v])).rows[0]!.k;
  it('telefone: ignora máscara e prefixo +55', async () => {
    for (const x of ['(11) 98888-7777', '+55 11 98888-7777', '5511988887777']) expect(await key('phone_key', x), x).toBe('11988887777');
    expect(await key('phone_key', '1234')).toBe('1234');
    expect(await key('phone_key', '+1 415 555 0100')).toBe('14155550100');
    expect(await key('phone_key', null)).toBe('');
  });
  it('nome: ignora acento, caixa e espaços; documento: só dígitos', async () => {
    expect(await key('name_key', '  MARIA   da Conceição ')).toBe('maria da conceicao');
    expect(await key('name_key', 'José Ângelo')).toBe(await key('name_key', 'jose angelo'));
    expect(await key('doc_key', '123.456.789-00')).toBe('12345678900');
  });
  it('inserção direta no banco (sem a API) também recebe as chaves: o seed e importações são detectados', async () => {
    const c = await clinic();
    await appPool.query('BEGIN');
    await appPool.query("SELECT set_config('app.tenant_id', $1, true)", [c.t.id]);
    await appPool.query("INSERT INTO patients (tenant_id, name, phone) VALUES ($1, 'Inserido Direto', '(11) 95555-4444')", [c.t.id]);
    await appPool.query('COMMIT');
    const dup = await c.create({ name: 'Inserido Outro', phone: '+55 11 95555-4444' }, false);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().candidates[0].name).toBe('Inserido Direto');
  });
});
