import { useState, type FormEvent } from 'react';
import { api, del, get, patch, post } from '../api';
import { dateTimeOf } from '../format';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';
import { PatientPicker } from './Agenda';

// ------------------------------------------------------------------ responsáveis
interface Guardian { id: string; name: string; relationship: string; phone: string | null; email: string | null; legalGuardian: boolean }

export function Guardians({ patientId, canWrite }: { patientId: string; canWrite: boolean }) {
  const toast = useToast();
  const g = useLoad(() => get<{ guardians: Guardian[] }>(`/api/patients/${patientId}/guardians`), [patientId]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', relationship: '', phone: '', email: '', legal: false });
  const [error, setError] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (f.name.trim().length < 2 || f.relationship.trim().length < 2) return setError('Informe o nome e o parentesco.');
    try { await post(`/api/patients/${patientId}/guardians`, { name: f.name, relationship: f.relationship, phone: f.phone || null, email: f.email || null, legalGuardian: f.legal }); toast('Responsável adicionado.'); setOpen(false); setF({ name: '', relationship: '', phone: '', email: '', legal: false }); g.reload(); }
    catch (err) { setError((err as Error).message); }
  }
  async function end(x: Guardian) {
    if (!window.confirm(`Encerrar o vínculo com ${x.name}? O histórico é mantido.`)) return;
    try { await del(`/api/patients/${patientId}/guardians/${x.id}`); toast('Vínculo encerrado.'); g.reload(); } catch (err) { toast((err as Error).message, 'bad'); }
  }
  return (
    <section className="card" aria-labelledby="guard-title">
      <div className="row between"><h2 id="guard-title">Responsáveis</h2>{canWrite && <Button variant="secondary" className="btn-sm" onClick={() => { setError(null); setOpen(true); }}>Adicionar</Button>}</div>
      {g.loading && !g.data && <Spinner />}
      {g.error && <ErrorBox message={g.error} onRetry={g.reload} />}
      {g.data?.guardians.length === 0 && <p className="small muted">Nenhum responsável cadastrado. Importante para menores de idade e pacientes dependentes.</p>}
      <ul className="list">
        {g.data?.guardians.map((x) => (
          <li key={x.id} className="list-item stack">
            <div className="row between"><strong>{x.name}</strong>{x.legalGuardian && <Badge tone="info">Responsável legal</Badge>}</div>
            <span className="small muted">{x.relationship}{x.phone ? ` · ${x.phone}` : ''}{x.email ? ` · ${x.email}` : ''}</span>
            {canWrite && <Button variant="secondary" className="btn-sm" onClick={() => end(x)}>Encerrar vínculo</Button>}
          </li>
        ))}
      </ul>
      <Sheet open={open} title="Adicionar responsável" onClose={() => setOpen(false)}>
        <form onSubmit={add} noValidate>
          <TextInput label="Nome" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
          <TextInput label="Parentesco" value={f.relationship} onChange={(v) => setF({ ...f, relationship: v })} hint="Exemplo: mãe, pai, tutor." />
          <div className="grid2"><TextInput label="Telefone" type="tel" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} inputMode="tel" /><TextInput label="E-mail" type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} inputMode="email" /></div>
          <label className="check"><input type="checkbox" checked={f.legal} onChange={(e) => setF({ ...f, legal: e.target.checked })} /> É o responsável legal</label>
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" className="btn-block">Adicionar responsável</Button>
        </form>
      </Sheet>
    </section>
  );
}

// ------------------------------------------------------------------ privacidade (direitos do titular) e exportação
interface PReq { id: string; kind: string; status: string; details: string | null; openedAt: string; dueAt: string; resolution: string | null }
const KIND: Record<string, string> = { access: 'Acesso aos dados', correction: 'Correção de dados', export: 'Cópia / portabilidade', deletion: 'Exclusão', objection: 'Oposição ao tratamento', information: 'Informações sobre o tratamento' };
const PSTATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'ok' | 'bad' }> = { open: { label: 'Aberta', tone: 'neutral' }, in_progress: { label: 'Em andamento', tone: 'info' }, done: { label: 'Concluída', tone: 'ok' }, rejected: { label: 'Recusada', tone: 'bad' } };

export function PrivacyCard({ patientId, patientName, canExport }: { patientId: string; patientName: string; canExport: boolean }) {
  const toast = useToast();
  const r = useLoad(() => get<{ requests: PReq[] }>(`/api/patients/${patientId}/privacy`), [patientId]);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('access');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function openReq(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await post(`/api/patients/${patientId}/privacy`, { kind, details: details || null }); toast('Solicitação registrada.'); setOpen(false); setDetails(''); r.reload(); }
    catch (err) { setError((err as Error).message); }
  }
  async function exportData() {
    try {
      const data = await api('GET', `/api/patients/${patientId}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = `dados-${patientName.normalize('NFD').replace(/[^\w]+/g, '-').toLowerCase()}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Exportação gerada e registrada na auditoria.');
    } catch (err) { toast((err as Error).message, 'bad'); }
  }
  return (
    <section className="card" aria-labelledby="priv-title">
      <div className="row between"><h2 id="priv-title">Privacidade e dados</h2><Button variant="secondary" className="btn-sm" onClick={() => { setError(null); setOpen(true); }}>Registrar solicitação</Button></div>
      <p className="small muted">Solicitações do paciente sobre seus dados. Prazo de referência de 15 dias; confirme as regras com o responsável jurídico.</p>
      {canExport && <Button variant="secondary" className="btn-sm" onClick={exportData}>Exportar dados do paciente</Button>}
      {r.data?.requests.length === 0 && <p className="small muted">Nenhuma solicitação.</p>}
      <ul className="list">
        {r.data?.requests.map((q) => (
          <li key={q.id} className="list-item stack">
            <div className="row between"><strong>{KIND[q.kind]}</strong><Badge tone={PSTATUS[q.status]!.tone}>{PSTATUS[q.status]!.label}</Badge></div>
            <span className="small muted">Aberta em {dateTimeOf(q.openedAt)} · prazo {dateTimeOf(q.dueAt)}{q.details ? ` · ${q.details}` : ''}</span>
            {q.resolution && <span className="small">Resposta: {q.resolution}</span>}
          </li>
        ))}
      </ul>
      <Sheet open={open} title="Registrar solicitação" onClose={() => setOpen(false)}>
        <form onSubmit={openReq} noValidate>
          <Select label="Tipo" value={kind} onChange={setKind}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <TextInput label="Detalhes (opcional)" value={details} onChange={setDetails} maxLength={1000} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" className="btn-block">Registrar solicitação</Button>
        </form>
      </Sheet>
    </section>
  );
}

// ------------------------------------------------------------------ mesclagem
export function MergeSheet({ source, target, onClose, onDone }: { source: { id: string; name: string } | null; target: { id: string; name: string } | null; onClose: () => void; onDone: (targetId: string) => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!source || !target) return;
    setBusy(true); setError(null);
    try { await post(`/api/patients/${source.id}/merge`, { intoId: target.id, reason }); toast('Cadastros mesclados.'); setReason(''); onDone(target.id); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <Sheet open={!!source && !!target} title="Mesclar cadastros" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p>O cadastro <strong>{source?.name}</strong> será mesclado em <strong>{target?.name}</strong>, que passa a ser o cadastro principal.</p>
        <ul className="small">
          <li>Nada é apagado: prontuário assinado e lançamentos financeiros continuam registrados e aparecem no cadastro principal.</li>
          <li>Consultas marcadas e lista de espera passam para o principal.</li>
          <li>Autorizações de comunicação precisam ser confirmadas de novo no cadastro principal.</li>
          <li>A ação fica na auditoria e não pode ser desfeita pela tela.</li>
        </ul>
        <TextInput label="Motivo da mesclagem" value={reason} onChange={setReason} error={error} hint="Exemplo: cadastro repetido na recepção." />
        <div className="row"><Button type="submit" variant="danger" busy={busy} disabled={reason.trim().length < 5}>Mesclar cadastros</Button><Button type="button" variant="secondary" onClick={onClose}>Voltar</Button></div>
      </form>
    </Sheet>
  );
}

export function MergeButton({ patient, onMerged }: { patient: { id: string; name: string }; onMerged: (targetId: string) => void }) {
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [targetId, setTargetId] = useState('');
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Button variant="secondary" className="btn-sm" onClick={() => { setQ(''); setTargetId(''); setPicking(true); }}>Mesclar com outro cadastro</Button>
      <Sheet open={picking && !confirm} title="Escolher o cadastro principal" onClose={() => setPicking(false)}>
        <p className="small">Busque o cadastro que deve ser mantido. O cadastro atual ({patient.name}) será mesclado nele.</p>
        <PatientPicker q={q} setQ={setQ} patientId={targetId} setPatientId={setTargetId} open={picking} />
        <Button className="btn-block" disabled={!targetId || targetId === patient.id} onClick={() => setConfirm(true)}>Continuar</Button>
      </Sheet>
      <MergeSheet source={confirm ? patient : null} target={confirm ? { id: targetId, name: q } : null} onClose={() => { setConfirm(false); setPicking(false); }} onDone={(t) => { setConfirm(false); setPicking(false); onMerged(t); }} />
    </>
  );
}

// ------------------------------------------------------------------ revisão de duplicados
interface Pair { aId: string; aName: string; aBirth: string | null; aPhone: string | null; bId: string; bName: string; bBirth: string | null; bPhone: string | null; reason: string }

export function Duplicates({ onBack }: { onBack: () => void }) {
  const toast = useToast();
  const d = useLoad(() => get<{ pairs: Pair[] }>('/api/patients/duplicates'), []);
  const [merge, setMerge] = useState<{ source: { id: string; name: string }; target: { id: string; name: string } } | null>(null);
  async function dismiss(p: Pair) {
    if (!window.confirm('Marcar como "não é duplicado"? O par deixa de aparecer na revisão.')) return;
    try { await post('/api/patients/duplicates/dismiss', { aId: p.aId, bId: p.bId }); toast('Par removido da revisão.'); d.reload(); } catch (e) { toast((e as Error).message, 'bad'); }
  }
  const info = (name: string, birth: string | null, phone: string | null) => <span><strong>{name}</strong><br /><span className="small muted">{birth ?? 'sem nascimento'} · {phone ?? 'sem telefone'}</span></span>;
  return (
    <>
      <p><button className="btn btn-ghost btn-sm" onClick={onBack}>← Pacientes</button></p>
      <div className="page-head"><h1>Possíveis duplicados</h1></div>
      {d.loading && !d.data && <Spinner />}
      {d.error && <ErrorBox message={d.error} onRetry={d.reload} />}
      {d.data?.pairs.length === 0 && <Empty title="Nenhum possível duplicado">Quando houver cadastros parecidos, eles aparecem aqui para revisão.</Empty>}
      <ul className="list">
        {d.data?.pairs.map((p) => (
          <li key={`${p.aId}-${p.bId}`} className="list-item stack">
            <Badge tone="warn">{p.reason}</Badge>
            <div className="grid2">{info(p.aName, p.aBirth, p.aPhone)}{info(p.bName, p.bBirth, p.bPhone)}</div>
            <div className="row">
              <Button className="btn-sm" variant="secondary" onClick={() => setMerge({ source: { id: p.bId, name: p.bName }, target: { id: p.aId, name: p.aName } })}>Manter “{p.aName}”</Button>
              <Button className="btn-sm" variant="secondary" onClick={() => setMerge({ source: { id: p.aId, name: p.aName }, target: { id: p.bId, name: p.bName } })}>Manter “{p.bName}”</Button>
              <Button className="btn-sm" variant="ghost" onClick={() => dismiss(p)}>Não é duplicado</Button>
            </div>
            <span className="small muted">Ao manter um cadastro, o outro é mesclado nele (nada é apagado).</span>
          </li>
        ))}
      </ul>
      <MergeSheet source={merge?.source ?? null} target={merge?.target ?? null} onClose={() => setMerge(null)} onDone={() => { setMerge(null); d.reload(); }} />
    </>
  );
}

// ------------------------------------------------------------------ fila de privacidade (Gestão)
interface QItem { id: string; kind: string; status: string; details: string | null; dueAt: string; overdue: boolean; patientId: string; patientName: string }

export function PrivacyQueue() {
  const toast = useToast();
  const q = useLoad(() => get<{ requests: QItem[] }>('/api/privacy/requests'), []);
  const [resolve, setResolve] = useState<{ item: QItem; status: 'done' | 'rejected' } | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function start(i: QItem) { try { await patch(`/api/privacy/requests/${i.id}`, { status: 'in_progress' }); q.reload(); } catch (e) { toast((e as Error).message, 'bad'); } }
  async function finish(e: FormEvent) {
    e.preventDefault();
    if (!resolve) return;
    setError(null);
    try { await patch(`/api/privacy/requests/${resolve.item.id}`, { status: resolve.status, resolution: text }); toast('Solicitação resolvida.'); setResolve(null); setText(''); q.reload(); }
    catch (err) { setError((err as Error).message); }
  }
  if (q.loading && !q.data) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox message={q.error ?? 'Erro'} onRetry={q.reload} />;
  return (
    <>
      <p className="small muted">Solicitações de titulares de dados em aberto, das mais urgentes para as menos. Prazo de referência de 15 dias; confirme com o responsável jurídico.</p>
      {q.data.requests.length === 0 && <Empty title="Nenhuma solicitação em aberto" />}
      <ul className="list">
        {q.data.requests.map((i) => (
          <li key={i.id} className="list-item stack">
            <div className="row between"><strong>{KIND[i.kind]}</strong><span className="row">{i.overdue && <Badge tone="bad">Vencida</Badge>}<Badge tone={PSTATUS[i.status]!.tone}>{PSTATUS[i.status]!.label}</Badge></span></div>
            <span className="small"><a href={`#/pacientes/${i.patientId}`}>{i.patientName}</a> · prazo {dateTimeOf(i.dueAt)}{i.details ? ` · ${i.details}` : ''}</span>
            <div className="row">
              {i.status === 'open' && <Button variant="secondary" className="btn-sm" onClick={() => start(i)}>Iniciar</Button>}
              <Button className="btn-sm" onClick={() => { setText(''); setError(null); setResolve({ item: i, status: 'done' }); }}>Concluir</Button>
              <Button variant="secondary" className="btn-sm" onClick={() => { setText(''); setError(null); setResolve({ item: i, status: 'rejected' }); }}>Recusar</Button>
            </div>
          </li>
        ))}
      </ul>
      <Sheet open={!!resolve} title={resolve?.status === 'done' ? 'Concluir solicitação' : 'Recusar solicitação'} onClose={() => setResolve(null)}>
        <form onSubmit={finish} noValidate>
          <TextInput label={resolve?.status === 'done' ? 'Resposta dada ao titular' : 'Motivo da recusa'} value={text} onChange={setText} error={error} hint="Fica registrado e não pode ser alterado depois." />
          <Button type="submit" className="btn-block" disabled={text.trim().length < 5}>{resolve?.status === 'done' ? 'Concluir' : 'Recusar'}</Button>
        </form>
      </Sheet>
    </>
  );
}
