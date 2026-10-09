import { Documents } from './Documents';
import { Images } from './Images';
import { PortalCard } from './PortalStaff';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, get, patch, post, type Me } from '../api';
import { brl, dateTimeOf, KIND_LABEL, METHOD_LABEL, parseMoney } from '../format';
import { Consents, MessageHistory } from './Messages';
import { Duplicates, Guardians, MergeButton, PrivacyCard } from './PatientAdmin';
import { Odontogram } from './Odontogram';
import { OnlineCharges } from './OnlinePayments';
import { Badge, Button, Empty, ErrorBox, Field, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

interface Patient { id: string; name: string; socialName: string | null; birthDate: string | null; phone: string | null; email: string | null; document: string | null; alert: string | null; mergedInto?: string | null }

export function Patients({ me }: { me: Me }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<'list' | 'dups'>('list');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const list = useLoad(() => get<{ patients: Patient[] }>(`/api/patients${debounced ? `?q=${encodeURIComponent(debounced)}` : ''}`), [debounced]);
  const canWrite = me.permissions.includes('patients.write');
  if (view === 'dups') return <Duplicates onBack={() => { setView('list'); list.reload(); }} />;

  return (
    <>
      <div className="page-head">
        <h1>Pacientes</h1>
        <span className="row">{me.permissions.includes('patients.merge') && <Button variant="secondary" onClick={() => setView('dups')}>Possíveis duplicados</Button>}{canWrite && <Button onClick={() => setCreating(true)}>Novo paciente</Button>}</span>
      </div>
      <Field label="Buscar por nome, telefone ou documento">
        {(id) => <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />}
      </Field>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && list.data.patients.length === 0 && (
        <Empty title={debounced ? 'Nenhum paciente encontrado' : 'Nenhum paciente cadastrado'}>
          {canWrite && !debounced && <Button onClick={() => setCreating(true)}>Cadastrar primeiro paciente</Button>}
        </Empty>
      )}
      <ul className="list">
        {list.data?.patients.map((p) => (
          <li key={p.id}>
            <a className="list-item link" href={`#/pacientes/${p.id}`}>
              <div className="row between"><strong>{p.socialName ? `${p.socialName} (${p.name})` : p.name}</strong>{p.alert && <Badge tone="warn">Alerta</Badge>}</div>
              <span className="muted small">{p.phone ?? 'Sem telefone'}</span>
            </a>
          </li>
        ))}
      </ul>
      <Sheet open={creating} title="Novo paciente" onClose={() => setCreating(false)}>
        <PatientForm canAlert={me.permissions.includes('notes.read')} onSaved={(id) => { setCreating(false); window.location.hash = `/pacientes/${id}`; }} />
      </Sheet>
    </>
  );
}

function PatientForm({ initial, canAlert, onSaved }: { initial?: Patient; canAlert: boolean; onSaved: (id: string) => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: initial?.name ?? '', socialName: initial?.socialName ?? '', birthDate: initial?.birthDate ?? '', phone: initial?.phone ?? '',
    email: initial?.email ?? '', document: initial?.document ?? '', alert: initial?.alert ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [dups, setDups] = useState<{ id: string; name: string; birthDate: string | null; phone: string | null; reason: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  async function submit(e: FormEvent, confirmNotDuplicate = false) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (f.name.trim().length < 2) errs.name = 'Informe o nome do paciente.';
    if (f.email && !/^\S+@\S+\.\S{2,}$/.test(f.email)) errs.email = 'Informe um e-mail válido, como nome@dominio.com.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true); setServerError(null); setDups([]);
    const body = { ...f, birthDate: f.birthDate || null, ...(canAlert ? {} : { alert: undefined }), ...(confirmNotDuplicate ? { confirmNotDuplicate: true } : {}) };
    try {
      if (initial) { await patch(`/api/patients/${initial.id}`, body); toast('Dados do paciente salvos.'); onSaved(initial.id); }
      else { const r = await post<{ id: string }>('/api/patients', body); toast('Paciente cadastrado.'); onSaved(r.id); }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'possible_duplicate') setDups((err.data.candidates as typeof dups) ?? []);
      setServerError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={(e) => submit(e)} noValidate>
      <TextInput label="Nome completo" value={f.name} onChange={set('name')} error={errors.name} required autoComplete="off" />
      <TextInput label="Nome social (opcional)" value={f.socialName} onChange={set('socialName')} />
      <div className="grid2">
        <TextInput label="Data de nascimento" type="date" value={f.birthDate} onChange={set('birthDate')} />
        <TextInput label="Telefone" type="tel" value={f.phone} onChange={set('phone')} inputMode="tel" />
        <TextInput label="E-mail" type="email" value={f.email} onChange={set('email')} error={errors.email} inputMode="email" />
        <TextInput label="CPF ou documento" value={f.document} onChange={set('document')} />
      </div>
      {canAlert && <TextInput label="Alerta clínico (visível só à equipe clínica)" value={f.alert} onChange={set('alert')} hint="Exemplo: alergia a penicilina." />}
      {serverError && <p className="field-msg error" role="alert">{serverError}</p>}
      {dups.length > 0 && (
        <div className="card">
          <p className="small"><strong>Cadastros parecidos:</strong></p>
          <ul className="list">{dups.map((d) => <li key={d.id} className="list-item"><a href={`#/pacientes/${d.id}`}><strong>{d.name}</strong></a><br /><span className="small muted">{d.reason}{d.birthDate ? ` · ${d.birthDate}` : ''}{d.phone ? ` · ${d.phone}` : ''}</span></li>)}</ul>
          <Button type="button" variant="secondary" className="btn-block" busy={busy} onClick={(e) => submit(e as unknown as FormEvent, true)}>Não é a mesma pessoa: cadastrar mesmo assim</Button>
        </div>
      )}
      <Button type="submit" busy={busy} className="btn-block">{initial ? 'Salvar alterações' : 'Cadastrar paciente'}</Button>
    </form>
  );
}

export function PatientDetail({ id, me }: { id: string; me: Me }) {
  const p = useLoad(() => get<{ patient: Patient }>(`/api/patients/${id}`), [id]);
  const has = (c: string) => me.entitlements.includes(c);
  const can = (x: string) => me.permissions.includes(x);
  const tabs = useMemo(() => [
    { key: 'dados', label: 'Dados', show: true },
    { key: 'prontuario', label: 'Prontuário', show: has('clinical.record') && can('notes.read') },
    { key: 'imagens', label: 'Imagens', show: has('clinical.record') && can('notes.read') && can('documents.read') },
    { key: 'documentos', label: 'Documentos', show: has('clinical.record') && can('documents.read') },
    { key: 'mensagens', label: 'Mensagens', show: has('communication.inbox') && can('comm.read') },
    { key: 'odontograma', label: 'Odontograma', show: has('dental.odontogram') && can('dental.read') },
    { key: 'financeiro', label: 'Financeiro', show: has('finance.basic') && can('finance.read') },
  ].filter((t) => t.show), [me]);
  const [tab, setTab] = useState('dados');

  if (p.loading && !p.data) return <Spinner />;
  if (p.error || !p.data) return <><p><a href="#/pacientes">← Pacientes</a></p><ErrorBox message={p.error ?? 'Paciente não encontrado.'} onRetry={p.reload} /></>;
  const patient = p.data.patient;
  if (patient.mergedInto) {
    return (<><p><a href="#/pacientes">← Pacientes</a></p><div className="banner" role="note">Este cadastro foi mesclado a outro. O histórico dele aparece no cadastro principal.</div><a className="btn btn-primary" href={`#/pacientes/${patient.mergedInto}`}>Abrir cadastro principal</a></>);
  }

  return (
    <>
      <p><a href="#/pacientes">← Pacientes</a></p>
      <div className="page-head"><h1>{patient.socialName ?? patient.name}</h1></div>
      {patient.alert && <div className="banner" role="note">⚠ {patient.alert}</div>}
      <div className="tabs" role="tablist">
        {tabs.map((t) => <button key={t.key} role="tab" aria-selected={tab === t.key} className="tab" onClick={() => setTab(t.key)}>{t.label}</button>)}
      </div>
      {tab === 'dados' && <div className="stack"><div className="card"><PatientForm initial={patient} canAlert={can('notes.read')} onSaved={() => p.reload()} /></div><Consents patientId={id} canWrite={can('patients.write')} />{has('patient.portal') && can('portal.manage') && <PortalCard patientId={id} />}<Guardians patientId={id} canWrite={can('patients.write')} />{can('privacy.open') && <PrivacyCard patientId={id} patientName={patient.name} canExport={can('patients.export')} />}{can('patients.merge') && <div><MergeButton patient={{ id, name: patient.name }} onMerged={(t) => { window.location.hash = `/pacientes/${t}`; }} /></div>}</div>}
      {tab === 'mensagens' && <MessageHistory patientId={id} />}
      {tab === 'imagens' && <Images patientId={id} canWrite={can('documents.write')} canShare={has('patient.portal')} />}
      {tab === 'documentos' && <Documents patientId={id} canWrite={can('documents.write')} canClinical={can('notes.read')} canShare={has('patient.portal')} />}
      {tab === 'prontuario' && <Notes patientId={id} meId={me.user.id} />}
      {tab === 'odontograma' && <Odontogram patientId={id} canWrite={can('dental.write')} hasFinance={has('finance.basic')} />}
      {tab === 'financeiro' && <PatientFinance patientId={id} canWrite={can('finance.write')} canDiscount={has('finance.advanced') && can('finance.write')} online={has('payments.gateway') && can('finance.read') ? { charge: can('payments.charge'), refund: can('finance.approve') } : null} />}
    </>
  );
}

interface Note { id: string; body: string; status: 'draft' | 'signed'; signedAt: string | null; createdAt: string; parentNoteId: string | null; addendumReason: string | null; authorId: string; authorName: string }

function Notes({ patientId, meId }: { patientId: string; meId: string }) {
  const toast = useToast();
  const draftKey = `draft:${patientId}`;
  const notes = useLoad(() => get<{ notes: Note[] }>(`/api/patients/${patientId}/notes`), [patientId]);
  // Rascunho local (sessionStorage, limpo no logout) evita perder texto clínico por queda de conexão/aba.
  const [text, setText] = useState(() => { try { return sessionStorage.getItem(draftKey) ?? ''; } catch { return ''; } });
  useEffect(() => { try { text ? sessionStorage.setItem(draftKey, text) : sessionStorage.removeItem(draftKey); } catch { /* opcional */ } }, [text, draftKey]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [signing, setSigning] = useState<Note | null>(null);
  const [addendumFor, setAddendumFor] = useState<Note | null>(null);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try { await fn(); toast(ok); notes.reload(); return true; } catch (e) { toast((e as Error).message, 'bad'); return false; } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <form className="card" onSubmit={async (e) => { e.preventDefault(); if (await run(() => post(`/api/patients/${patientId}/notes`, { body: text }), 'Rascunho salvo.')) setText(''); }}>
        <Field label="Novo registro clínico" hint="O texto é preservado neste aparelho até você salvar. Registros mais recentes aparecem primeiro.">
          {(id, d) => <textarea id={id} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={d} />}
        </Field>
        <Button type="submit" busy={busy} disabled={!text.trim()}>Salvar como rascunho</Button>
      </form>

      {notes.loading && !notes.data && <Spinner />}
      {notes.error && <ErrorBox message={notes.error} onRetry={notes.reload} />}
      {notes.data?.notes.length === 0 && <Empty title="Nenhum registro ainda">Escreva a primeira evolução acima.</Empty>}
      <div className="timeline stack">
        {notes.data && [...notes.data.notes].reverse().map((n) => (
          <article key={n.id} className={`card note${n.parentNoteId ? ' addendum' : ''}`}>
            <div className="row between">
              <span className="small muted">{n.authorName} · {dateTimeOf(n.createdAt)}</span>
              {n.status === 'signed' ? <Badge tone="ok">Assinado</Badge> : <Badge tone="warn">Rascunho</Badge>}
            </div>
            {n.parentNoteId && <p className="small"><strong>Adendo:</strong> {n.addendumReason}</p>}
            {editing?.id === n.id ? (
              <>
                <Field label="Editar rascunho">{(id) => <textarea id={id} value={editing.body} onChange={(e) => setEditing({ id: n.id, body: e.target.value })} />}</Field>
                <div className="row">
                  <Button busy={busy} onClick={async () => { if (await run(() => patch(`/api/notes/${n.id}`, { body: editing.body }), 'Rascunho atualizado.')) setEditing(null); }}>Salvar</Button>
                  <Button variant="secondary" onClick={() => setEditing(null)}>Cancelar</Button>
                </div>
              </>
            ) : <p className="pre">{n.body}</p>}
            {n.status === 'draft' && n.authorId === meId && editing?.id !== n.id && (
              <div className="row"><Button variant="secondary" className="btn-sm" onClick={() => setEditing({ id: n.id, body: n.body })}>Editar rascunho</Button><Button className="btn-sm" onClick={() => setSigning(n)}>Assinar</Button></div>
            )}
            {n.status === 'signed' && !n.parentNoteId && <Button variant="secondary" className="btn-sm" onClick={() => setAddendumFor(n)}>Registrar adendo</Button>}
          </article>
        ))}
      </div>

      <Sheet open={!!signing} title="Assinar registro" onClose={() => setSigning(null)}>
        <p>Após assinado, o registro <strong>não poderá ser alterado</strong>. Correções serão feitas por adendo, com justificativa.</p>
        <div className="row">
          <Button busy={busy} onClick={async () => { if (signing && await run(() => post(`/api/notes/${signing.id}/sign`), 'Registro assinado.')) setSigning(null); }}>Assinar registro</Button>
          <Button variant="secondary" onClick={() => setSigning(null)}>Voltar</Button>
        </div>
      </Sheet>
      <AddendumSheet note={addendumFor} onClose={() => setAddendumFor(null)} onDone={() => { setAddendumFor(null); notes.reload(); }} />
    </div>
  );
}

function AddendumSheet({ note, onClose, onDone }: { note: Note | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!note) return;
    setBusy(true); setError(null);
    try { await post(`/api/notes/${note.id}/addendum`, { body, reason }); toast('Adendo registrado.'); setBody(''); setReason(''); onDone(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <Sheet open={!!note} title="Registrar adendo" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <TextInput label="Justificativa" value={reason} onChange={setReason} hint="Por que este registro precisa ser complementado ou corrigido?" />
        <Field label="Texto do adendo">{(id) => <textarea id={id} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" busy={busy} disabled={!body.trim() || reason.trim().length < 5}>Registrar adendo</Button>
      </form>
    </Sheet>
  );
}

interface Movement { id: string; kind: string; method: string | null; amountCents: string; note: string | null; createdAt: string; receiptNumber: number | null }

export function PatientFinance({ patientId, canWrite, canDiscount, online }: { patientId: string; canWrite: boolean; canDiscount: boolean; online: { charge: boolean; refund: boolean } | null }) {
  const toast = useToast();
  const fin = useLoad(() => get<{ movements: Movement[]; balanceCents: string; chargedCents: string; paidCents: string; discountedCents: string }>(`/api/patients/${patientId}/finance`), [patientId]);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('payment');
  const [method, setMethod] = useState('pix');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID()); // evita lançamento duplicado em duplo clique
  const [discOpen, setDiscOpen] = useState(false);
  const [discAmount, setDiscAmount] = useState('');
  const [discReason, setDiscReason] = useState('');

  async function submitDiscount(e: FormEvent) {
    e.preventDefault();
    const cents = parseMoney(discAmount);
    if (!cents || cents <= 0) { setError('Informe um valor válido, como 20,00.'); return; }
    setBusy(true); setError(null);
    try {
      await post('/api/finance/discount-requests', { patientId, amountCents: cents, reason: discReason });
      toast('Pedido enviado para aprovação.'); setDiscOpen(false); setDiscAmount(''); setDiscReason('');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseMoney(amount);
    if (!cents || cents <= 0) { setError('Informe um valor válido, como 150,00.'); return; }
    setBusy(true); setError(null);
    try {
      await post('/api/finance/movements', { patientId, kind, method: kind === 'charge' ? undefined : method, amountCents: cents, note: note || undefined, idempotencyKey: key });
      toast('Lançamento registrado.'); setOpen(false); setAmount(''); setNote(''); setKey(crypto.randomUUID()); fin.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  if (fin.loading && !fin.data) return <Spinner />;
  if (fin.error || !fin.data) return <ErrorBox message={fin.error ?? 'Erro ao carregar.'} onRetry={fin.reload} />;
  const owed = BigInt(fin.data.balanceCents);
  return (
    <div className="stack">
      <div className="stats">
        <div className="stat"><b>{brl(fin.data.chargedCents)}</b><span>Cobrado</span></div>
        <div className="stat"><b>{brl(fin.data.paidCents)}</b><span>Pago</span></div>
        <div className="stat"><b>{brl(fin.data.balanceCents)}</b><span>{owed > 0n ? 'Em aberto' : owed < 0n ? 'Crédito' : 'Quitado'}</span></div>
      </div>
      {BigInt(fin.data.discountedCents) > 0n && <p className="small muted">Desconto aplicado: {brl(fin.data.discountedCents)}</p>}
      {(canWrite || canDiscount) && (
        <div className="row">
          {canWrite && <Button onClick={() => { setError(null); setOpen(true); }}>Registrar lançamento</Button>}
          {canDiscount && owed > 0n && <Button variant="secondary" onClick={() => { setError(null); setDiscOpen(true); }}>Pedir desconto</Button>}
        </div>
      )}
      {fin.data.movements.length === 0 && <Empty title="Sem movimentos financeiros" />}
      <ul className="list">
        {fin.data.movements.map((m) => (
          <li key={m.id} className="list-item row between">
            <div><strong>{KIND_LABEL[m.kind]}</strong>{m.method && <> · {METHOD_LABEL[m.method]}</>}<br /><span className="small muted">{dateTimeOf(m.createdAt)}{m.note ? ` · ${m.note}` : ''}</span>
              {m.kind === 'payment' && <><br /><a className="small" href={`#/recibo/${m.id}`}>Ver recibo{m.receiptNumber ? ` nº ${m.receiptNumber}` : ''}</a></>}</div>
            <strong>{m.kind === 'payment' ? '+' : m.kind === 'refund' || m.kind === 'discount' ? '−' : ''}{brl(m.amountCents)}</strong>
          </li>
        ))}
      </ul>
      {online && <OnlineCharges patientId={patientId} balanceCents={fin.data.balanceCents} canCharge={online.charge} canRefund={online.refund} onChanged={fin.reload} />}
      <Sheet open={open} title="Registrar lançamento" onClose={() => setOpen(false)}>
        <form onSubmit={submit} noValidate>
          <Select label="Tipo" value={kind} onChange={setKind}><option value="payment">Pagamento recebido</option><option value="charge">Cobrança</option><option value="refund">Estorno</option></Select>
          {kind !== 'charge' && <Select label="Forma de pagamento" value={method} onChange={setMethod}><option value="pix">Pix</option><option value="card">Cartão</option><option value="cash">Dinheiro</option></Select>}
          <TextInput label="Valor (R$)" value={amount} onChange={setAmount} inputMode="decimal" placeholder="150,00" />
          <TextInput label="Observação (opcional)" value={note} onChange={setNote} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Registrar</Button>
        </form>
      </Sheet>
      <Sheet open={discOpen} title="Pedir desconto" onClose={() => setDiscOpen(false)}>
        <form onSubmit={submitDiscount} noValidate>
          <p className="small muted">O desconto só vale depois da aprovação de quem gerencia o financeiro. Ele não pode passar do valor em aberto ({brl(fin.data.balanceCents)}).</p>
          <TextInput label="Valor do desconto (R$)" value={discAmount} onChange={setDiscAmount} inputMode="decimal" placeholder="20,00" />
          <TextInput label="Motivo" value={discReason} onChange={setDiscReason} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Enviar pedido</Button>
        </form>
      </Sheet>
    </div>
  );
}
