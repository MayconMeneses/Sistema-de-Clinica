import { useState, type FormEvent } from 'react';
import { get, post } from '../api';
import { dateTimeOf } from '../format';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';
import { FormSheet, type FormField } from './FormFill';

interface Template { id: string; key: string; version: number; name: string; fields: FormField[]; active: boolean }
const TYPE_LABEL: Record<FormField['type'], string> = { text: 'Texto curto', longtext: 'Texto longo', yesno: 'Sim ou não', choice: 'Uma opção', multichoice: 'Várias opções', number: 'Número', date: 'Data', scale: 'Escala 0 a 10' };

/** Gestão → Formulários: instalar modelos prontos, criar/editar (nova versão) e ativar/desativar. */
export function FormTemplates({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const list = useLoad(() => get<{ templates: Template[] }>('/api/form-templates?all=1'), []);
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  async function defaults() {
    try { const r = await post<{ installed: string[] }>('/api/form-templates/defaults'); toast(r.installed.length ? `Instalados: ${r.installed.join(', ')}. Revise o conteúdo antes de usar.` : 'Os modelos prontos já estão instalados.'); list.reload(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  }
  async function toggle(t: Template) {
    try { await post(`/api/form-templates/${t.id}/active`, { active: !t.active }); list.reload(); } catch (e) { toast((e as Error).message, 'bad'); }
  }
  return (
    <>
      {canManage && <div className="row between"><Button variant="secondary" onClick={defaults}>Instalar modelos prontos</Button><Button onClick={() => setEditing('new')}>Novo formulário</Button></div>}
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data?.templates.length === 0 && <Empty title="Nenhum formulário">Instale os modelos prontos ou crie o seu. Os modelos prontos são ponto de partida: o profissional responsável deve revisá-los.</Empty>}
      <ul className="list">
        {list.data?.templates.map((t) => (
          <li key={t.id} className="list-item stack">
            <div className="row between"><strong>{t.name}</strong><span className="row"><Badge>v{t.version}</Badge>{t.active ? <Badge tone="ok">Ativo</Badge> : <Badge tone="warn">Desativado</Badge>}</span></div>
            <span className="small muted">{t.fields.length} perguntas</span>
            {canManage && <div className="row"><Button variant="secondary" className="btn-sm" onClick={() => setEditing(t)}>Editar (nova versão)</Button><Button variant="ghost" className="btn-sm" onClick={() => toggle(t)}>{t.active ? 'Desativar' : 'Ativar'}</Button></div>}
          </li>
        ))}
      </ul>
      <TemplateEditor target={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); list.reload(); }} />
    </>
  );
}

interface Draft { label: string; type: FormField['type']; required: boolean; options: string }

function TemplateEditor({ target, onClose, onDone }: { target: Template | 'new' | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const base = target && target !== 'new' ? target : null;
  const toDraft = (f: FormField): Draft => ({ label: f.label, type: f.type, required: !!f.required, options: (f.options ?? []).join(', ') });
  const [name, setName] = useState('');
  const [rows, setRows] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seed, setSeed] = useState<unknown>(null);
  if (target !== seed) { setSeed(target); setName(base?.name ?? ''); setRows(base ? base.fields.map(toDraft) : [{ label: '', type: 'text', required: false, options: '' }]); setError(null); }
  const upd = (i: number, p: Partial<Draft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const used = new Set<string>();
    const fields = rows.map((r, i) => {
      let id = r.label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || `campo_${i + 1}`;
      if (!/^[a-z]/.test(id)) id = `c_${id}`;
      while (used.has(id)) id = `${id.slice(0, 36)}_${i}`;
      used.add(id);
      const o: Record<string, unknown> = { id, label: r.label.trim(), type: r.type, required: r.required };
      if (r.type === 'choice' || r.type === 'multichoice') o.options = r.options.split(',').map((x) => x.trim()).filter(Boolean);
      return o;
    });
    setBusy(true);
    try { await post('/api/form-templates', { name: name.trim(), key: base?.key, fields }); toast('Formulário salvo.'); onDone(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <Sheet open={!!target} title={base ? 'Editar formulário' : 'Novo formulário'} onClose={onClose}>
      <form onSubmit={save} noValidate>
        <TextInput label="Nome do formulário" value={name} onChange={setName} />
        {rows.map((r, i) => (
          <div key={i} className="card stack">
            <TextInput label={`Pergunta ${i + 1}`} value={r.label} onChange={(v) => upd(i, { label: v })} />
            <Select label="Tipo de resposta" value={r.type} onChange={(v) => upd(i, { type: v as FormField['type'] })}>{Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
            {(r.type === 'choice' || r.type === 'multichoice') && <TextInput label="Opções (separadas por vírgula)" value={r.options} onChange={(v) => upd(i, { options: v })} />}
            <div className="row between"><label className="row"><input type="checkbox" checked={r.required} onChange={(e) => upd(i, { required: e.target.checked })} /> Obrigatória</label>
              {rows.length > 1 && <Button type="button" variant="ghost" className="btn-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remover</Button>}</div>
          </div>
        ))}
        <Button type="button" variant="secondary" onClick={() => setRows([...rows, { label: '', type: 'text', required: false, options: '' }])}>Adicionar pergunta</Button>
        <p className="small muted">Editar cria uma nova versão. O que já foi respondido continua ligado à versão que o paciente viu.</p>
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" busy={busy} className="btn-block">Salvar formulário</Button>
      </form>
    </Sheet>
  );
}

interface FormRow { id: string; status: 'pending' | 'submitted' | 'canceled'; createdAt: string; submittedAt: string | null; submittedVia: string | null; templateName: string; templateVersion: number; fields?: FormField[]; answers: Record<string, unknown> | null }
interface TriageRow { id: string; recordedAt: string; weightKg: number | null; heightCm: number | null; bpSystolic: number | null; bpDiastolic: number | null; heartRate: number | null; temperatureC: number | null; painScale: number | null; allergies: string | null; medications: string | null; complaint: string | null; notes: string | null; recordedByName: string | null }

const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v === true ? 'Sim' : v === false ? 'Não' : String(v));

/** Aba do paciente: pedir formulário, preencher na recepção, ler respostas (só prontuário) e triagem. */
export function PatientForms({ patientId, canAssign, canTriageWrite, canTriageRead }: { patientId: string; canAssign: boolean; canTriageWrite: boolean; canTriageRead: boolean }) {
  const toast = useToast();
  const forms = useLoad(() => get<{ forms: FormRow[]; canReadAnswers: boolean }>(`/api/patients/${patientId}/forms`), [patientId]);
  const templates = useLoad(() => (canAssign ? get<{ templates: Template[] }>('/api/form-templates') : Promise.resolve({ templates: [] })), []);
  const triage = useLoad(() => (canTriageRead ? get<{ triage: TriageRow[] }>(`/api/patients/${patientId}/triage`) : Promise.resolve({ triage: [] })), [patientId]);
  const [tpl, setTpl] = useState('');
  const [filling, setFilling] = useState<string | null>(null);
  const [triaging, setTriaging] = useState(false);
  async function request() {
    if (!tpl) return;
    try { await post(`/api/patients/${patientId}/forms`, { templateId: tpl }); toast('Formulário enviado ao paciente.'); setTpl(''); forms.reload(); } catch (e) { toast((e as Error).message, 'bad'); }
  }
  async function cancel(id: string) {
    try { await post(`/api/forms/${id}/cancel`); forms.reload(); } catch (e) { toast((e as Error).message, 'bad'); }
  }
  return (
    <div className="stack">
      {canAssign && (
        <div className="card stack">
          <Select label="Pedir um formulário" value={tpl} onChange={setTpl}><option value="">Escolha…</option>{templates.data?.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
          <Button onClick={request} disabled={!tpl}>Pedir ao paciente</Button>
          <p className="small muted">Se o paciente tiver o portal, ele preenche pelo celular. Também dá para preencher aqui na recepção.</p>
        </div>
      )}
      {forms.loading && !forms.data && <Spinner />}
      {forms.error && <ErrorBox message={forms.error} onRetry={forms.reload} />}
      {forms.data?.forms.length === 0 && <Empty title="Nenhum formulário">Peça uma anamnese antes da consulta.</Empty>}
      <ul className="list">
        {forms.data?.forms.map((f) => (
          <li key={f.id} className="list-item stack">
            <div className="row between"><strong>{f.templateName} <span className="small muted">v{f.templateVersion}</span></strong>
              {f.status === 'pending' ? <Badge tone="warn">Aguardando</Badge> : f.status === 'submitted' ? <Badge tone="ok">Respondido</Badge> : <Badge>Cancelado</Badge>}</div>
            <span className="small muted">Pedido em {dateTimeOf(f.createdAt)}{f.submittedAt ? ` · respondido em ${dateTimeOf(f.submittedAt)} (${f.submittedVia === 'portal' ? 'pelo paciente' : 'na recepção'})` : ''}</span>
            {f.status === 'pending' && canAssign && <div className="row"><Button className="btn-sm" onClick={() => setFilling(f.id)}>Preencher aqui</Button><Button variant="ghost" className="btn-sm" onClick={() => cancel(f.id)}>Cancelar pedido</Button></div>}
            {f.status === 'submitted' && f.answers && f.fields && (
              <dl className="answers">{f.fields.filter((x) => f.answers![x.id] !== undefined).map((x) => <div key={x.id}><dt className="small muted">{x.label}</dt><dd>{show(f.answers![x.id])}</dd></div>)}</dl>
            )}
          </li>
        ))}
      </ul>
      {(canTriageWrite || canTriageRead) && (
        <>
          <div className="row between"><h3>Triagem</h3>{canTriageWrite && <Button className="btn-sm" onClick={() => setTriaging(true)}>Nova triagem</Button>}</div>
          {canTriageRead && triage.data?.triage.length === 0 && <p className="small muted">Nenhuma triagem registrada.</p>}
          <ul className="list">
            {triage.data?.triage.map((t) => (
              <li key={t.id} className="list-item stack">
                <strong>{dateTimeOf(t.recordedAt)}</strong>
                <span className="small">{[t.weightKg != null && `${t.weightKg} kg`, t.heightCm != null && `${t.heightCm} cm`, t.bpSystolic != null && `PA ${t.bpSystolic}/${t.bpDiastolic}`, t.heartRate != null && `FC ${t.heartRate}`, t.temperatureC != null && `${t.temperatureC} °C`, t.painScale != null && `dor ${t.painScale}/10`].filter(Boolean).join(' · ')}</span>
                {t.complaint && <span className="small">Queixa: {t.complaint}</span>}
                {t.allergies && <span className="small">Alergias: {t.allergies}</span>}
                {t.medications && <span className="small">Medicamentos: {t.medications}</span>}
                {t.notes && <span className="small">{t.notes}</span>}
                <span className="small muted">por {t.recordedByName ?? '—'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <FormSheet id={filling} base="/api/forms" get={get} post={post} onClose={() => setFilling(null)} onDone={() => { setFilling(null); toast('Respostas registradas.'); forms.reload(); }} />
      <TriageSheet patientId={triaging ? patientId : null} onClose={() => setTriaging(false)} onDone={() => { setTriaging(false); triage.reload(); }} />
    </div>
  );
}

const NUM: [string, string][] = [['weightKg', 'Peso (kg)'], ['heightCm', 'Altura (cm)'], ['bpSystolic', 'Pressão máxima (ex.: 120)'], ['bpDiastolic', 'Pressão mínima (ex.: 80)'], ['heartRate', 'Batimentos por minuto'], ['temperatureC', 'Temperatura (°C)'], ['painScale', 'Dor (0 a 10)']];
const TXT: [string, string][] = [['complaint', 'Queixa principal'], ['allergies', 'Alergias'], ['medications', 'Medicamentos em uso'], ['notes', 'Observações']];

/** Triagem de recepção/enfermagem. Registro único; correção = nova triagem. */
export function TriageSheet({ patientId, appointmentId, onClose, onDone }: { patientId: string | null; appointmentId?: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!patientId) return;
    setError(null);
    const body: Record<string, unknown> = {};
    for (const [k] of NUM) if (f[k]?.trim()) { const n = Number(f[k]!.replace(',', '.')); if (!Number.isFinite(n)) return setError('Use só números nos campos numéricos.'); body[k] = n; }
    for (const [k] of TXT) if (f[k]?.trim()) body[k] = f[k]!.trim();
    if (appointmentId) body.appointmentId = appointmentId;
    setBusy(true);
    try { await post(`/api/patients/${patientId}/triage`, body); toast('Triagem registrada.'); setF({}); onDone(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <Sheet open={!!patientId} title="Triagem" onClose={onClose}>
      <form onSubmit={save} noValidate>
        {NUM.map(([k, l]) => <TextInput key={k} label={l} inputMode="decimal" value={f[k] ?? ''} onChange={(v) => setF({ ...f, [k]: v })} />)}
        {TXT.map(([k, l]) => <TextInput key={k} label={l} value={f[k] ?? ''} onChange={(v) => setF({ ...f, [k]: v })} />)}
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" busy={busy} className="btn-block">Registrar triagem</Button>
      </form>
    </Sheet>
  );
}
