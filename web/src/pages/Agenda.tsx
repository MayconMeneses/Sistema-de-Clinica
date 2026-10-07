import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, get, patch, post, type Me } from '../api';
import { brl, dayLabel, dayRange, parseMoney, shiftDay, STATUS_LABEL, timeOf, todayYmd, toIso } from '../format';
import { MonthGrid, shiftMonth, weekStartOf, WeekView } from './AgendaViews';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

interface Appt { id: string; startsAt: string; endsAt: string; status: string; service: string; priceCents: string; cancelReason: string | null; priority: string; seriesId: string | null; outsideHours: boolean; patientId: string; patientName: string; professionalId: string; professionalName: string; resourceName: string | null }
interface Block { id: string; startsAt: string; endsAt: string; reason: string; professionalId: string | null; professionalName: string | null; resourceName: string | null }
interface WaitEntry { id: string; patientId: string; patientName: string; professionalName: string | null; notes: string | null; priority: string }
type Pro = { id: string; name: string };

const TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'bad' | 'info'> = { scheduled: 'neutral', confirmed: 'info', checked_in: 'warn', called: 'info', in_service: 'info', completed: 'ok', cancelled: 'bad', no_show: 'bad' };
const NEXT: Record<string, { to: string; label: string }[]> = {
  scheduled: [{ to: 'confirmed', label: 'Confirmar' }, { to: 'checked_in', label: 'Chegou' }],
  confirmed: [{ to: 'checked_in', label: 'Chegou' }],
  checked_in: [{ to: 'called', label: 'Chamar' }, { to: 'in_service', label: 'Iniciar' }],
  called: [{ to: 'in_service', label: 'Iniciar' }],
  in_service: [{ to: 'completed', label: 'Concluir' }],
};

export function Agenda({ me }: { me: Me }) {
  const toast = useToast();
  const [day, setDay] = useState(todayYmd());
  const [view, setView] = useState<'day' | 'week' | 'month'>('day');
  const [pro, setPro] = useState('');
  const pros = useLoad(() => get<{ professionals: Pro[] }>('/api/professionals'), []);
  const weekStart = weekStartOf(day);
  const monthStart = `${day.slice(0, 7)}-01`;
  const range = view === 'week' ? { from: dayRange(weekStart).from, to: dayRange(shiftDay(weekStart, 7)).from }
    : view === 'month' ? { from: dayRange(monthStart).from, to: dayRange(shiftMonth(monthStart, 1)).from }
    : dayRange(day);
  const proQ = pro ? `&professionalId=${pro}` : '';
  const list = useLoad(() => (view === 'month' ? Promise.resolve({ appointments: [] as Appt[] })
    : get<{ appointments: Appt[] }>(`/api/appointments?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}${proQ}`)), [view, day, pro]);
  const summary = useLoad(() => (view === 'month'
    ? get<{ days: { day: string; active: number; completed: number; lost: number }[] }>(`/api/appointments/summary?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}${proQ}`)
    : Promise.resolve({ days: [] })), [view, day, pro]);
  const blocks = useLoad(() => get<{ blocks: Block[] }>('/api/blocks'), []);
  const wait = useLoad(() => get<{ entries: WaitEntry[] }>('/api/waitlist'), []);
  const [creating, setCreating] = useState(false);
  const [prefill, setPrefill] = useState<{ id: string; name: string } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [cancelFor, setCancelFor] = useState<Appt | null>(null);
  const [moveFor, setMoveFor] = useState<Appt | null>(null);
  const canWrite = me.permissions.includes('agenda.write');

  const dayBlocks = (blocks.data?.blocks ?? []).filter((b) => new Date(b.startsAt) < new Date(range.to) && new Date(b.endsAt) > new Date(range.from) && (!pro || !b.professionalId || b.professionalId === pro));

  async function change(a: Appt, status: string) {
    try { await patch(`/api/appointments/${a.id}`, { status }); toast(`${a.patientName}: ${STATUS_LABEL[status]?.toLowerCase()}.`); list.reload(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  }
  async function resolveWait(w: WaitEntry, status: 'scheduled' | 'cancelled') {
    try { await patch(`/api/waitlist/${w.id}`, { status }); wait.reload(); } catch (e) { toast((e as Error).message, 'bad'); }
  }

  return (
    <>
      <div className="page-head">
        <h1>Agenda</h1>
        {canWrite && <Button onClick={() => { setPrefill(null); setCreating(true); }}>Novo agendamento</Button>}
      </div>
      <div className="switch" role="group" aria-label="Visão da agenda">
        <button type="button" aria-pressed={view === 'day'} onClick={() => setView('day')}>Dia</button>
        <button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>Semana</button>
        <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')}>Mês</button>
      </div>
      <div className="daynav">
        <Button variant="secondary" className="btn-sm" onClick={() => setDay(view === 'month' ? shiftMonth(day, -1) : shiftDay(day, view === 'week' ? -7 : -1))} aria-label={view === 'month' ? 'Mês anterior' : view === 'week' ? 'Semana anterior' : 'Dia anterior'}>‹</Button>
        <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Escolher dia" />
        <Button variant="secondary" className="btn-sm" onClick={() => setDay(view === 'month' ? shiftMonth(day, 1) : shiftDay(day, view === 'week' ? 7 : 1))} aria-label={view === 'month' ? 'Próximo mês' : view === 'week' ? 'Próxima semana' : 'Próximo dia'}>›</Button>
        <Button variant="ghost" className="btn-sm" onClick={() => setDay(todayYmd())}>Hoje</Button>
      </div>
      <Select label="Profissional" value={pro} onChange={setPro}>
        <option value="">Todos</option>
        {pros.data?.professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
      <h2 className="muted">{view === 'day' ? dayLabel(day) : view === 'week' ? `Semana de ${weekStart.split('-').reverse().slice(0, 2).join('/')} a ${shiftDay(weekStart, 6).split('-').reverse().slice(0, 2).join('/')}` : new Date(`${monthStart}T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h2>
      {view === 'day' && dayBlocks.map((b) => <div key={b.id} className="banner" role="note">Bloqueado: {b.reason} ({b.professionalName ?? b.resourceName ?? 'clínica inteira'}), {timeOf(b.startsAt)}–{timeOf(b.endsAt)}</div>)}
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {view === 'week' && list.data && <WeekView weekStart={weekStart} appointments={list.data.appointments} blocks={dayBlocks} onOpenDay={(d) => { setDay(d); setView('day'); }} />}
      {view === 'week' && list.data?.appointments.length === 500 && <p className="small muted" role="note">Mostrando as primeiras 500 consultas da semana. Filtre por profissional para ver o restante.</p>}
      {view === 'month' && summary.error && <ErrorBox message={summary.error} onRetry={summary.reload} />}
      {view === 'month' && summary.data && <MonthGrid monthStart={monthStart} days={summary.data.days} blocks={dayBlocks} onOpenDay={(d) => { setDay(d); setView('day'); }} />}
      {view === 'day' && list.data && list.data.appointments.length === 0 && (
        <Empty title="Nenhuma consulta neste dia">{canWrite && <Button onClick={() => { setPrefill(null); setCreating(true); }}>Agendar consulta</Button>}</Empty>
      )}
      <ul className="list">
        {view === 'day' && list.data?.appointments.map((a) => (
          <li key={a.id} className="list-item appt">
            <div className="row between">
              <span className="appt-time">{timeOf(a.startsAt)}–{timeOf(a.endsAt)}</span>
              <span className="row">
                {a.outsideHours && <Badge tone="warn">Encaixe</Badge>}
                {a.priority === 'priority' && <Badge tone="warn">Prioridade</Badge>}
                <Badge tone={TONE[a.status] ?? 'neutral'}>{STATUS_LABEL[a.status]}</Badge>
              </span>
            </div>
            <a href={`#/pacientes/${a.patientId}`}><strong>{a.patientName}</strong></a>
            <span className="muted small">{a.service} · {a.professionalName}{a.resourceName ? ` · ${a.resourceName}` : ''}{Number(a.priceCents) > 0 ? ` · ${brl(a.priceCents)}` : ''}{a.seriesId ? ' · série' : ''}</span>
            {a.cancelReason && <span className="small">Motivo: {a.cancelReason}</span>}
            {canWrite && (
              <div className="appt-actions">
                {NEXT[a.status]?.map((n) => <Button key={n.to} className="btn-sm" onClick={() => change(a, n.to)}>{n.label}</Button>)}
                {['scheduled', 'confirmed'].includes(a.status) && <Button variant="secondary" className="btn-sm" onClick={() => setMoveFor(a)}>Reagendar</Button>}
                {['scheduled', 'confirmed'].includes(a.status) && <Button variant="secondary" className="btn-sm" onClick={() => change(a, 'no_show')}>Faltou</Button>}
                {['scheduled', 'confirmed', 'checked_in', 'called'].includes(a.status) && <Button variant="danger" className="btn-sm" onClick={() => setCancelFor(a)}>Cancelar</Button>}
              </div>
            )}
          </li>
        ))}
      </ul>

      <section className="card" aria-labelledby="wait-title">
        <div className="row between"><h2 id="wait-title">Lista de espera ({wait.data?.entries.length ?? 0})</h2>{canWrite && <Button variant="secondary" className="btn-sm" onClick={() => setWaiting(true)}>Adicionar</Button>}</div>
        {wait.data?.entries.length === 0 && <p className="small muted">Ninguém aguardando uma vaga.</p>}
        <ul className="list">
          {wait.data?.entries.map((w) => (
            <li key={w.id} className="list-item stack">
              <div className="row between"><strong>{w.patientName}</strong>{w.priority === 'priority' && <Badge tone="warn">Prioridade</Badge>}</div>
              <span className="small muted">{w.professionalName ?? 'Qualquer profissional'}{w.notes ? ` · ${w.notes}` : ''}</span>
              {canWrite && <div className="row"><Button className="btn-sm" onClick={() => { setPrefill({ id: w.patientId, name: w.patientName }); setCreating(true); void resolveWait(w, 'scheduled'); }}>Agendar</Button><Button variant="secondary" className="btn-sm" onClick={() => resolveWait(w, 'cancelled')}>Remover da lista</Button></div>}
            </li>
          ))}
        </ul>
      </section>

      <NewAppointment open={creating} day={day} prefill={prefill} pros={pros.data?.professionals ?? []} canOverride={me.permissions.includes('schedule.override')} onClose={() => setCreating(false)} onDone={() => { setCreating(false); list.reload(); }} />
      <WaitSheet open={waiting} pros={pros.data?.professionals ?? []} onClose={() => setWaiting(false)} onDone={() => { setWaiting(false); wait.reload(); }} />
      <CancelSheet appt={cancelFor} onClose={() => setCancelFor(null)} onDone={() => { setCancelFor(null); list.reload(); }} />
      <MoveSheet appt={moveFor} canOverride={me.permissions.includes('schedule.override')} onClose={() => setMoveFor(null)} onDone={() => { setMoveFor(null); list.reload(); }} />
    </>
  );
}

export function PatientPicker({ q, setQ, patientId, setPatientId, open }: { q: string; setQ: (v: string) => void; patientId: string; setPatientId: (v: string) => void; open: boolean }) {
  const found = useLoad(() => (open && q.trim().length >= 2 ? get<{ patients: { id: string; name: string }[] }>(`/api/patients?q=${encodeURIComponent(q.trim())}`) : Promise.resolve({ patients: [] })), [q, open]);
  return (
    <>
      <TextInput label="Paciente" value={q} onChange={(v) => { setQ(v); setPatientId(''); }} hint="Digite ao menos 2 letras do nome." autoComplete="off" />
      {found.data && found.data.patients.length > 0 && !patientId && (
        <ul className="list" aria-label="Resultados">
          {found.data.patients.slice(0, 5).map((p) => <li key={p.id}><button type="button" className="btn btn-secondary btn-block" onClick={() => { setPatientId(p.id); setQ(p.name); }}>{p.name}</button></li>)}
        </ul>
      )}
      {q.trim().length >= 2 && found.data?.patients.length === 0 && !found.loading && !patientId && <p className="small muted">Nenhum paciente encontrado. Cadastre-o primeiro em Pacientes.</p>}
    </>
  );
}

function NewAppointment({ open, day, prefill, pros, canOverride, onClose, onDone }: { open: boolean; day: string; prefill: { id: string; name: string } | null; pros: Pro[]; canOverride: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const rooms = useLoad(() => (open ? get<{ resources: { id: string; name: string; unitName: string }[] }>('/api/resources') : Promise.resolve({ resources: [] })), [open]);
  const [q, setQ] = useState('');
  const [patientId, setPatientId] = useState('');
  const [proId, setProId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [date, setDate] = useState(day);
  const [start, setStart] = useState('09:00');
  const [minutes, setMinutes] = useState('50');
  const [service, setService] = useState('Consulta');
  const [price, setPrice] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [count, setCount] = useState('4');
  const [skip, setSkip] = useState(false);
  const [encaixe, setEncaixe] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setDate(day); setError(null); setEncaixe(false); if (prefill) { setQ(prefill.name); setPatientId(prefill.id); } } }, [open, day, prefill]);
  useEffect(() => { if (!proId && pros[0]) setProId(pros[0].id); }, [pros, proId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cents = price ? parseMoney(price) : 0;
    const dur = Number(minutes);
    const n = Number(count);
    if (!patientId) return setError({ message: 'Escolha o paciente na lista de resultados.' });
    if (!proId) return setError({ message: 'Escolha o profissional.' });
    if (cents === null) return setError({ message: 'Informe o valor como 150,00.' });
    if (!Number.isInteger(dur) || dur < 5 || dur > 480) return setError({ message: 'A duração deve estar entre 5 e 480 minutos.' });
    if (repeat && (!Number.isInteger(n) || n < 2 || n > 26)) return setError({ message: 'Repita de 2 a 26 vezes.' });
    const startsAt = toIso(date, start);
    const endsAt = new Date(new Date(startsAt).getTime() + dur * 60000).toISOString();
    const body = { patientId, professionalId: proId, resourceId: roomId || null, startsAt, endsAt, service, priceCents: cents, encaixe };
    setBusy(true);
    try {
      if (repeat) {
        const r = await post<{ created: number; conflicts: { startsAt: string; reason: string }[] }>('/api/appointments/series', { ...body, count: n, everyDays: 7, skipConflicts: skip });
        toast(r.conflicts.length ? `${r.created} consultas agendadas; ${r.conflicts.length} data(s) puladas por conflito.` : `${r.created} consultas agendadas.`);
      } else {
        await post('/api/appointments', body);
        toast('Consulta agendada.');
      }
      setQ(''); setPatientId(''); setRepeat(false); onDone();
    } catch (err) { setError({ message: (err as Error).message, code: err instanceof ApiError ? err.code : undefined }); } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} title="Novo agendamento" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <PatientPicker q={q} setQ={setQ} patientId={patientId} setPatientId={setPatientId} open={open} />
        <Select label="Profissional" value={proId} onChange={setProId}>{pros.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        {rooms.data && rooms.data.resources.length > 0 && (
          <Select label="Sala ou equipamento (opcional)" value={roomId} onChange={setRoomId}><option value="">Sem sala específica</option>{rooms.data.resources.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.unitName}</option>)}</Select>
        )}
        <div className="grid2">
          <TextInput label="Data" type="date" value={date} onChange={setDate} />
          <TextInput label="Horário" type="time" value={start} onChange={setStart} />
          <TextInput label="Duração (min)" value={minutes} onChange={setMinutes} inputMode="numeric" />
          <TextInput label="Valor (R$, opcional)" value={price} onChange={setPrice} inputMode="decimal" placeholder="150,00" />
        </div>
        <TextInput label="Serviço" value={service} onChange={setService} />
        <label className="check"><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> Repetir semanalmente</label>
        {repeat && (
          <>
            <TextInput label="Quantas consultas no total" value={count} onChange={setCount} inputMode="numeric" hint="De 2 a 26, uma por semana, no mesmo dia e horário." />
            <label className="check"><input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> Pular datas com conflito (senão, nada é agendado se houver conflito)</label>
          </>
        )}
        {error && <p className="field-msg error" role="alert">{error.message}</p>}
        {error?.code === 'outside_hours' && canOverride && (
          <label className="check"><input type="checkbox" checked={encaixe} onChange={(e) => setEncaixe(e.target.checked)} /> Registrar como encaixe (fora do horário de atendimento)</label>
        )}
        <Button type="submit" busy={busy} className="btn-block">{repeat ? 'Agendar série' : 'Agendar consulta'}</Button>
      </form>
    </Sheet>
  );
}

function WaitSheet({ open, pros, onClose, onDone }: { open: boolean; pros: Pro[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [patientId, setPatientId] = useState('');
  const [proId, setProId] = useState('');
  const [notes, setNotes] = useState('');
  const [priority, setPriority] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!patientId) return setError('Escolha o paciente na lista de resultados.');
    setError(null);
    try { await post('/api/waitlist', { patientId, professionalId: proId || null, notes: notes || null, priority: priority ? 'priority' : 'normal' }); toast('Adicionado à lista de espera.'); setQ(''); setPatientId(''); setNotes(''); onDone(); }
    catch (err) { setError((err as Error).message); }
  }
  return (
    <Sheet open={open} title="Lista de espera" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <PatientPicker q={q} setQ={setQ} patientId={patientId} setPatientId={setPatientId} open={open} />
        <Select label="Profissional preferido" value={proId} onChange={setProId}><option value="">Qualquer um</option>{pros.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        <TextInput label="Observação (opcional)" value={notes} onChange={setNotes} maxLength={300} hint="Exemplo: prefere manhã." />
        <label className="check"><input type="checkbox" checked={priority} onChange={(e) => setPriority(e.target.checked)} /> Prioridade</label>
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" className="btn-block">Adicionar à lista</Button>
      </form>
    </Sheet>
  );
}

function CancelSheet({ appt, onClose, onDone }: { appt: Appt | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!appt) return;
    if (reason.trim().length < 3) return setError('Informe o motivo do cancelamento.');
    setBusy(true); setError(null);
    try { await patch(`/api/appointments/${appt.id}`, { status: 'cancelled', reason }); toast('Consulta cancelada. O horário foi liberado.'); setReason(''); onDone(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <Sheet open={!!appt} title="Cancelar consulta" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p>Cancelar a consulta de <strong>{appt?.patientName}</strong> às {appt && timeOf(appt.startsAt)}?</p>
        <TextInput label="Motivo do cancelamento" value={reason} onChange={setReason} error={error} />
        <div className="row"><Button type="submit" variant="danger" busy={busy}>Cancelar consulta</Button><Button type="button" variant="secondary" onClick={onClose}>Manter consulta</Button></div>
      </form>
    </Sheet>
  );
}

function MoveSheet({ appt, canOverride, onClose, onDone }: { appt: Appt | null; canOverride: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState('');
  const [start, setStart] = useState('');
  const [encaixe, setEncaixe] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (appt) { setDate(new Date(appt.startsAt).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })); setStart(timeOf(appt.startsAt)); setError(null); setEncaixe(false); }
  }, [appt]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!appt) return;
    const dur = new Date(appt.endsAt).getTime() - new Date(appt.startsAt).getTime();
    const startsAt = toIso(date, start);
    setBusy(true); setError(null);
    try { await patch(`/api/appointments/${appt.id}`, { startsAt, endsAt: new Date(new Date(startsAt).getTime() + dur).toISOString(), encaixe }); toast('Consulta reagendada.'); onDone(); }
    catch (err) { setError({ message: (err as Error).message, code: err instanceof ApiError ? err.code : undefined }); } finally { setBusy(false); }
  }
  return (
    <Sheet open={!!appt} title="Reagendar consulta" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p>Paciente: <strong>{appt?.patientName}</strong></p>
        <div className="grid2"><TextInput label="Nova data" type="date" value={date} onChange={setDate} /><TextInput label="Novo horário" type="time" value={start} onChange={setStart} /></div>
        {error && <p className="field-msg error" role="alert">{error.message}</p>}
        {error?.code === 'outside_hours' && canOverride && <label className="check"><input type="checkbox" checked={encaixe} onChange={(e) => setEncaixe(e.target.checked)} /> Registrar como encaixe</label>}
        <Button type="submit" busy={busy} className="btn-block">Reagendar</Button>
      </form>
    </Sheet>
  );
}
