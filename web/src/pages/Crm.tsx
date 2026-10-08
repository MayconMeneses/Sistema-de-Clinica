import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, get, patch, post } from '../api';
import { dateTimeOf, todayYmd } from '../format';
import { Badge, Button, Empty, ErrorBox, Field, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

type Stage = 'new' | 'contacted' | 'scheduled' | 'won' | 'lost';
interface Lead {
  id: string; name: string; phone: string | null; email: string | null; source: string; interest: string | null; stage: Stage; lostReason: string | null;
  ownerId: string | null; ownerName: string | null; nextContactOn: string | null; marketingConsent: boolean; patientId: string | null;
}
interface LeadEvent { id: string; kind: string; fromStage: string | null; toStage: string | null; note: string | null; createdAt: string; authorName: string | null }
interface Candidate { id: string; name: string; phone: string | null; reason: string }

const STAGE: Record<Stage, { label: string; tone: 'neutral' | 'info' | 'warn' | 'ok' | 'bad' }> = {
  new: { label: 'Novo', tone: 'neutral' }, contacted: { label: 'Contatado', tone: 'info' }, scheduled: { label: 'Agendado', tone: 'warn' }, won: { label: 'Virou paciente', tone: 'ok' }, lost: { label: 'Perdido', tone: 'bad' },
};
const SOURCE: Record<string, string> = { referral: 'Indicação', instagram: 'Instagram', google: 'Google', website: 'Site', whatsapp: 'WhatsApp', walk_in: 'Visita', other: 'Outro' };
const EVENT: Record<string, string> = { created: 'Cadastrado', stage: 'Mudou de etapa', note: 'Anotação', assigned: 'Responsável alterado', consent: 'Consentimento', converted: 'Virou paciente' };
const ymdBr = (d: string) => d.split('-').reverse().join('/');

export function CrmPage({ canWrite, canConvert, canSchedule = false }: { canWrite: boolean; canConvert: boolean; canSchedule?: boolean }) {
  const toast = useToast();
  const [stage, setStage] = useState<Stage | ''>('');
  const [due, setDue] = useState(false);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const list = useLoad(() => get<{ leads: Lead[]; counts: Record<Stage, number>; dueCount: number }>(`/api/crm/leads?${new URLSearchParams({ ...(stage ? { stage } : {}), ...(due ? { due: '1' } : {}), ...(debounced ? { q: debounced } : {}) })}`), [stage, due, debounced]);

  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<Lead | null>(null);
  const [lose, setLose] = useState<Lead | null>(null);
  const [note, setNote] = useState<Lead | null>(null);
  const [convert, setConvert] = useState<{ lead: Lead; candidates: Candidate[] } | null>(null);
  const [f, setF] = useState({ name: '', phone: '', email: '', source: 'other', interest: '', next: '', consent: false, reason: '', note: '', noteNext: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sched, setSched] = useState<{ lead: Lead; candidates: Candidate[] } | null>(null);
  const [sf, setSf] = useState({ proId: '', date: '', time: '09:00', minutes: '30', service: 'Avaliação' });
  const pros = useLoad(() => (canSchedule ? get<{ professionals: { id: string; name: string }[] }>('/api/professionals') : Promise.resolve({ professionals: [] })), []);

  async function submitSchedule(extra: object = {}) {
    if (!sched) return;
    if (!sf.proId || !sf.date || !/^\d{2}:\d{2}$/.test(sf.time)) { setError('Escolha o profissional, a data e a hora.'); return; }
    const minutes = Number(sf.minutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) { setError('Duração entre 5 e 480 minutos.'); return; }
    const startsAt = new Date(`${sf.date}T${sf.time}:00-03:00`);
    setBusy(true); setError(null);
    try {
      const r = await post<{ patientId: string }>(`/api/crm/leads/${sched.lead.id}/schedule`, {
        professionalId: sf.proId, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + minutes * 60_000).toISOString(), service: sf.service || 'Consulta', ...extra });
      toast('Consulta agendada e lead convertido em paciente.'); setSched(null); list.reload(); window.location.hash = `/pacientes/${r.patientId}`;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'possible_duplicate') setSched({ lead: sched.lead, candidates: (err.data.candidates as Candidate[]) ?? [] });
      else setError((err as Error).message);
    } finally { setBusy(false); }
  }

  async function run(fn: () => Promise<unknown>, ok: string, after?: () => void) {
    setBusy(true); setError(null);
    try { await fn(); toast(ok); after?.(); list.reload(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const today = todayYmd();

  async function startConvert(lead: Lead, body: object = {}) {
    setBusy(true); setError(null);
    try {
      const r = await post<{ patientId: string }>(`/api/crm/leads/${lead.id}/convert`, body);
      toast('Lead convertido em paciente.'); setConvert(null); list.reload(); window.location.hash = `/pacientes/${r.patientId}`;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'possible_duplicate') setConvert({ lead, candidates: (err.data.candidates as Candidate[]) ?? [] });
      else { setError((err as Error).message); toast((err as Error).message, 'bad'); }
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head"><h1>CRM</h1>{canWrite && <Button onClick={() => { setF({ ...f, name: '', phone: '', email: '', source: 'other', interest: '', next: '', consent: false }); setError(null); setCreating(true); }}>Novo lead</Button>}</div>
      <div className="stats">
        {(['new', 'contacted', 'scheduled', 'won'] as Stage[]).map((s) => <div className="stat" key={s}><b>{list.data?.counts[s] ?? '–'}</b><span>{STAGE[s].label}</span></div>)}
      </div>
      <div className="card">
        <Select label="Etapa" value={stage} onChange={(v) => setStage(v as Stage | '')}>
          <option value="">Todas</option>{(Object.keys(STAGE) as Stage[]).map((s) => <option key={s} value={s}>{STAGE[s].label}{list.data ? ` (${list.data.counts[s]})` : ''}</option>)}
        </Select>
        <Field label="Buscar lead" hint="Nome, telefone ou e-mail.">{(id, d) => <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-describedby={d} autoComplete="off" />}</Field>
        <label className="row"><input type="checkbox" checked={due} onChange={(e) => setDue(e.target.checked)} /> Só contatos para hoje ou atrasados{list.data ? ` (${list.data.dueCount})` : ''}</label>
      </div>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && list.data.leads.length === 0 && <Empty title="Nenhum lead encontrado">{canWrite && <Button onClick={() => setCreating(true)}>Cadastrar um lead</Button>}</Empty>}
      <ul className="list">
        {list.data?.leads.map((l) => {
          const late = l.nextContactOn && l.nextContactOn <= today && !['won', 'lost'].includes(l.stage);
          return (
            <li key={l.id} className="list-item stack">
              <div className="row between"><strong>{l.name}</strong><Badge tone={STAGE[l.stage].tone}>{STAGE[l.stage].label}</Badge></div>
              <span className="small muted">{SOURCE[l.source]}{l.interest ? ` · ${l.interest}` : ''}{l.phone ? ` · ${l.phone}` : ''}{l.email ? ` · ${l.email}` : ''}</span>
              <span className="small">{l.nextContactOn && !['won', 'lost'].includes(l.stage) && <><Badge tone={late ? 'bad' : 'neutral'}>Contato {ymdBr(l.nextContactOn)}</Badge> </>}{l.ownerName ? `Responsável: ${l.ownerName}` : 'Sem responsável'}{l.stage === 'lost' && l.lostReason ? ` · ${l.lostReason}` : ''}</span>
              <div className="row">
                {canWrite && ['new', 'contacted', 'scheduled'].includes(l.stage) && <>
                  {l.stage === 'new' && <Button className="btn-sm" onClick={() => run(() => patch(`/api/crm/leads/${l.id}`, { stage: 'contacted' }), 'Marcado como contatado.')}>Contatado</Button>}
                  {l.stage === 'contacted' && <Button className="btn-sm" onClick={() => run(() => patch(`/api/crm/leads/${l.id}`, { stage: 'scheduled' }), 'Marcado como agendado.')}>Agendou</Button>}
                  {canSchedule && <Button className="btn-sm" onClick={() => { setError(null); setSf({ ...sf, date: today, proId: sf.proId || pros.data?.professionals[0]?.id || '' }); setSched({ lead: l, candidates: [] }); }}>Agendar consulta</Button>}
                  {canConvert && <Button variant="secondary" className="btn-sm" onClick={() => startConvert(l)}>Virou paciente</Button>}
                  <Button variant="secondary" className="btn-sm" onClick={() => { setF({ ...f, note: '', noteNext: '' }); setError(null); setNote(l); }}>Anotar</Button>
                  <Button variant="secondary" className="btn-sm" onClick={() => { setF({ ...f, reason: '' }); setError(null); setLose(l); }}>Perdido</Button></>}
                {canWrite && l.stage === 'lost' && <Button variant="secondary" className="btn-sm" onClick={() => run(() => patch(`/api/crm/leads/${l.id}`, { stage: 'contacted' }), 'Lead reaberto.')}>Reabrir</Button>}
                {l.patientId && <a className="btn btn-secondary btn-sm" href={`#/pacientes/${l.patientId}`}>Abrir paciente</a>}
                <Button variant="ghost" className="btn-sm" onClick={() => setDetail(l)}>Histórico</Button>
              </div>
            </li>
          );
        })}
      </ul>

      <Sheet open={creating} title="Novo lead" onClose={() => setCreating(false)}>
        <form noValidate onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => post('/api/crm/leads', { name: f.name, phone: f.phone || undefined, email: f.email || undefined, source: f.source, interest: f.interest || undefined, nextContactOn: f.next || undefined, marketingConsent: f.consent }), 'Lead cadastrado.', () => setCreating(false)); }}>
          <TextInput label="Nome" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
          <div className="grid2"><TextInput label="Telefone" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} inputMode="tel" /><TextInput label="E-mail" value={f.email} onChange={(v) => setF({ ...f, email: v })} inputMode="email" /></div>
          <Select label="Como chegou" value={f.source} onChange={(v) => setF({ ...f, source: v })}>{Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <TextInput label="Interesse (opcional)" value={f.interest} onChange={(v) => setF({ ...f, interest: v })} />
          <TextInput label="Próximo contato (opcional)" type="date" value={f.next} onChange={(v) => setF({ ...f, next: v })} />
          <label className="row"><input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /> A pessoa autorizou receber comunicação de marketing</label>
          <p className="small muted">Sem essa autorização, não envie propaganda. Telefone ou e-mail é obrigatório.</p>
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Cadastrar lead</Button>
        </form>
      </Sheet>

      <Sheet open={lose !== null} title="Marcar como perdido" onClose={() => setLose(null)}>
        <form noValidate onSubmit={(e) => { e.preventDefault(); if (lose) void run(() => patch(`/api/crm/leads/${lose.id}`, { stage: 'lost', lostReason: f.reason }), 'Lead marcado como perdido.', () => setLose(null)); }}>
          <TextInput label="Motivo da perda" value={f.reason} onChange={(v) => setF({ ...f, reason: v })} hint="Exemplo: achou caro, foi para outra clínica." />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" variant="danger" busy={busy} className="btn-block">Marcar como perdido</Button>
        </form>
      </Sheet>

      <Sheet open={note !== null} title={note ? `Anotação: ${note.name}` : ''} onClose={() => setNote(null)}>
        <form noValidate onSubmit={(e) => { e.preventDefault(); if (note) void run(() => post(`/api/crm/leads/${note.id}/notes`, { note: f.note, nextContactOn: f.noteNext || undefined }), 'Anotação salva.', () => setNote(null)); }}>
          <TextInput label="O que aconteceu" value={f.note} onChange={(v) => setF({ ...f, note: v })} />
          <TextInput label="Próximo contato (opcional)" type="date" value={f.noteNext} onChange={(v) => setF({ ...f, noteNext: v })} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Salvar anotação</Button>
        </form>
      </Sheet>

      <Sheet open={convert !== null} title="Cadastro parecido encontrado" onClose={() => setConvert(null)}>
        {convert && (
          <div className="stack">
            <p>Já existe cadastro parecido com <strong>{convert.lead.name}</strong>. Ligue o lead a ele ou confirme que é outra pessoa.</p>
            <ul className="list">
              {convert.candidates.map((c) => (
                <li key={c.id} className="list-item row between"><div><strong>{c.name}</strong><br /><span className="small muted">{c.reason}{c.phone ? ` · ${c.phone}` : ''}</span></div>
                  <Button className="btn-sm" busy={busy} onClick={() => startConvert(convert.lead, { patientId: c.id })}>Ligar a este</Button></li>
              ))}
            </ul>
            <Button variant="secondary" busy={busy} onClick={() => startConvert(convert.lead, { confirmNotDuplicate: true })}>É outra pessoa: criar novo cadastro</Button>
          </div>
        )}
      </Sheet>

      <Sheet open={sched !== null} title={sched ? `Agendar: ${sched.lead.name}` : ''} onClose={() => setSched(null)}>
        {sched && sched.candidates.length === 0 && (
          <form onSubmit={(e) => { e.preventDefault(); void submitSchedule(); }} noValidate>
            <p className="small muted">O lead vira paciente e a consulta é marcada de uma vez. Se o horário estiver ocupado, nada é cadastrado.</p>
            <Select label="Profissional" value={sf.proId} onChange={(v) => setSf({ ...sf, proId: v })}>
              <option value="">Escolha…</option>{pros.data?.professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <div className="grid2">
              <Field label="Data">{(id) => <input id={id} type="date" value={sf.date} onChange={(e) => setSf({ ...sf, date: e.target.value })} />}</Field>
              <Field label="Hora">{(id) => <input id={id} type="time" value={sf.time} onChange={(e) => setSf({ ...sf, time: e.target.value })} />}</Field>
            </div>
            <div className="grid2">
              <TextInput label="Duração (min)" value={sf.minutes} onChange={(v) => setSf({ ...sf, minutes: v })} inputMode="numeric" />
              <TextInput label="Serviço" value={sf.service} onChange={(v) => setSf({ ...sf, service: v })} />
            </div>
            {error && <p className="field-msg error" role="alert">{error}</p>}
            <Button type="submit" busy={busy} className="btn-block">Agendar consulta</Button>
          </form>
        )}
        {sched && sched.candidates.length > 0 && (
          <div className="stack">
            <p>Já existe cadastro parecido com <strong>{sched.lead.name}</strong>. Ligue o lead a ele ou confirme que é outra pessoa.</p>
            <ul className="list">
              {sched.candidates.map((c) => (
                <li key={c.id} className="list-item row between"><div><strong>{c.name}</strong><br /><span className="small muted">{c.reason}{c.phone ? ` · ${c.phone}` : ''}</span></div>
                  <Button className="btn-sm" busy={busy} onClick={() => submitSchedule({ patientId: c.id })}>Ligar a este</Button></li>
              ))}
            </ul>
            <Button variant="secondary" busy={busy} onClick={() => submitSchedule({ confirmNotDuplicate: true })}>É outra pessoa: criar novo cadastro</Button>
            {error && <p className="field-msg error" role="alert">{error}</p>}
          </div>
        )}
      </Sheet>

      <LeadHistory lead={detail} onClose={() => setDetail(null)} />
    </>
  );
}

function LeadHistory({ lead, onClose }: { lead: Lead | null; onClose: () => void }) {
  const d = useLoad(() => (lead ? get<{ events: LeadEvent[] }>(`/api/crm/leads/${lead.id}`) : Promise.resolve({ events: [] as LeadEvent[] })), [lead?.id]);
  return (
    <Sheet open={lead !== null} title={lead ? `Histórico: ${lead.name}` : ''} onClose={onClose}>
      {d.loading && <Spinner />}
      {d.error && <ErrorBox message={d.error} onRetry={d.reload} />}
      <ul className="list">
        {d.data?.events.map((e) => (
          <li key={e.id} className="list-item">
            <strong>{EVENT[e.kind] ?? e.kind}</strong>{e.toStage ? `: ${e.fromStage ? `${STAGE[e.fromStage as Stage]?.label ?? e.fromStage} → ` : ''}${STAGE[e.toStage as Stage]?.label ?? e.toStage}` : ''}
            <br /><span className="small muted">{dateTimeOf(e.createdAt)} · {e.authorName ?? '—'}{e.note ? ` · ${e.note}` : ''}</span>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
