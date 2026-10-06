import { useEffect, useState, type FormEvent } from 'react';
import { get, patch, post, type Me } from '../api';
import { brl, dayLabel, dayRange, parseMoney, shiftDay, STATUS_LABEL, timeOf, todayYmd, toIso } from '../format';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

interface Appt { id: string; startsAt: string; endsAt: string; status: string; service: string; priceCents: string; cancelReason: string | null; patientId: string; patientName: string; professionalId: string; professionalName: string }
const TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'bad' | 'info'> = { scheduled: 'neutral', confirmed: 'info', checked_in: 'warn', completed: 'ok', cancelled: 'bad', no_show: 'bad' };
const NEXT: Record<string, { to: string; label: string }[]> = {
  scheduled: [{ to: 'confirmed', label: 'Confirmar' }, { to: 'checked_in', label: 'Chegou' }],
  confirmed: [{ to: 'checked_in', label: 'Chegou' }],
  checked_in: [{ to: 'completed', label: 'Concluir' }],
};

export function Agenda({ me }: { me: Me }) {
  const toast = useToast();
  const [day, setDay] = useState(todayYmd());
  const [pro, setPro] = useState('');
  const pros = useLoad(() => get<{ professionals: { id: string; name: string }[] }>('/api/professionals'), []);
  const range = dayRange(day);
  const list = useLoad(() => get<{ appointments: Appt[] }>(`/api/appointments?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}${pro ? `&professionalId=${pro}` : ''}`), [day, pro]);
  const [creating, setCreating] = useState(false);
  const [cancelFor, setCancelFor] = useState<Appt | null>(null);
  const [moveFor, setMoveFor] = useState<Appt | null>(null);
  const canWrite = me.permissions.includes('agenda.write');

  async function change(a: Appt, status: string) {
    try { await patch(`/api/appointments/${a.id}`, { status }); toast(`${a.patientName}: ${STATUS_LABEL[status]?.toLowerCase()}.`); list.reload(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  }

  return (
    <>
      <div className="page-head">
        <h1>Agenda</h1>
        {canWrite && <Button onClick={() => setCreating(true)}>Novo agendamento</Button>}
      </div>
      <div className="daynav">
        <Button variant="secondary" className="btn-sm" onClick={() => setDay(shiftDay(day, -1))} aria-label="Dia anterior">‹</Button>
        <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Escolher dia" />
        <Button variant="secondary" className="btn-sm" onClick={() => setDay(shiftDay(day, 1))} aria-label="Próximo dia">›</Button>
        <Button variant="ghost" className="btn-sm" onClick={() => setDay(todayYmd())}>Hoje</Button>
      </div>
      <Select label="Profissional" value={pro} onChange={setPro}>
        <option value="">Todos</option>
        {pros.data?.professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
      <h2 className="muted">{dayLabel(day)}</h2>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && list.data.appointments.length === 0 && (
        <Empty title="Nenhuma consulta neste dia">{canWrite && <Button onClick={() => setCreating(true)}>Agendar consulta</Button>}</Empty>
      )}
      <ul className="list">
        {list.data?.appointments.map((a) => (
          <li key={a.id} className="list-item appt">
            <div className="row between">
              <span className="appt-time">{timeOf(a.startsAt)}–{timeOf(a.endsAt)}</span>
              <Badge tone={TONE[a.status] ?? 'neutral'}>{STATUS_LABEL[a.status]}</Badge>
            </div>
            <a href={`#/pacientes/${a.patientId}`}><strong>{a.patientName}</strong></a>
            <span className="muted small">{a.service} · {a.professionalName}{Number(a.priceCents) > 0 ? ` · ${brl(a.priceCents)}` : ''}</span>
            {a.cancelReason && <span className="small">Motivo: {a.cancelReason}</span>}
            {canWrite && (
              <div className="appt-actions">
                {NEXT[a.status]?.map((n) => <Button key={n.to} className="btn-sm" onClick={() => change(a, n.to)}>{n.label}</Button>)}
                {['scheduled', 'confirmed'].includes(a.status) && <Button variant="secondary" className="btn-sm" onClick={() => setMoveFor(a)}>Reagendar</Button>}
                {['scheduled', 'confirmed'].includes(a.status) && <Button variant="secondary" className="btn-sm" onClick={() => change(a, 'no_show')}>Faltou</Button>}
                {['scheduled', 'confirmed', 'checked_in'].includes(a.status) && <Button variant="danger" className="btn-sm" onClick={() => setCancelFor(a)}>Cancelar</Button>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <NewAppointment open={creating} day={day} pros={pros.data?.professionals ?? []} onClose={() => setCreating(false)} onDone={() => { setCreating(false); list.reload(); }} />
      <CancelSheet appt={cancelFor} onClose={() => setCancelFor(null)} onDone={() => { setCancelFor(null); list.reload(); }} />
      <MoveSheet appt={moveFor} onClose={() => setMoveFor(null)} onDone={() => { setMoveFor(null); list.reload(); }} />
    </>
  );
}

function NewAppointment({ open, day, pros, onClose, onDone }: { open: boolean; day: string; pros: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [patientId, setPatientId] = useState('');
  const [proId, setProId] = useState('');
  const [date, setDate] = useState(day);
  const [start, setStart] = useState('09:00');
  const [minutes, setMinutes] = useState('50');
  const [service, setService] = useState('Consulta');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const found = useLoad(() => (open && q.trim().length >= 2 ? get<{ patients: { id: string; name: string }[] }>(`/api/patients?q=${encodeURIComponent(q.trim())}`) : Promise.resolve({ patients: [] })), [q, open]);
  useEffect(() => { if (open) setDate(day); }, [open, day]);
  useEffect(() => { if (!proId && pros[0]) setProId(pros[0].id); }, [pros, proId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cents = price ? parseMoney(price) : 0;
    const dur = Number(minutes);
    if (!patientId) return setError('Escolha o paciente na lista de resultados.');
    if (!proId) return setError('Escolha o profissional.');
    if (cents === null) return setError('Informe o valor como 150,00.');
    if (!Number.isInteger(dur) || dur < 5 || dur > 480) return setError('A duração deve estar entre 5 e 480 minutos.');
    const startsAt = toIso(date, start);
    const endsAt = new Date(new Date(startsAt).getTime() + dur * 60000).toISOString();
    setBusy(true);
    try { await post('/api/appointments', { patientId, professionalId: proId, startsAt, endsAt, service, priceCents: cents }); toast('Consulta agendada.'); setQ(''); setPatientId(''); onDone(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} title="Novo agendamento" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <TextInput label="Paciente" value={q} onChange={(v) => { setQ(v); setPatientId(''); }} hint="Digite ao menos 2 letras do nome." autoComplete="off" />
        {found.data && found.data.patients.length > 0 && !patientId && (
          <ul className="list" aria-label="Resultados">
            {found.data.patients.slice(0, 5).map((p) => <li key={p.id}><button type="button" className="btn btn-secondary btn-block" onClick={() => { setPatientId(p.id); setQ(p.name); }}>{p.name}</button></li>)}
          </ul>
        )}
        {q.trim().length >= 2 && found.data?.patients.length === 0 && !found.loading && <p className="small muted">Nenhum paciente encontrado. Cadastre-o primeiro em Pacientes.</p>}
        <Select label="Profissional" value={proId} onChange={setProId}>{pros.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        <div className="grid2">
          <TextInput label="Data" type="date" value={date} onChange={setDate} />
          <TextInput label="Horário" type="time" value={start} onChange={setStart} />
          <TextInput label="Duração (min)" value={minutes} onChange={setMinutes} inputMode="numeric" />
          <TextInput label="Valor (R$, opcional)" value={price} onChange={setPrice} inputMode="decimal" placeholder="150,00" />
        </div>
        <TextInput label="Serviço" value={service} onChange={setService} />
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" busy={busy} className="btn-block">Agendar consulta</Button>
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

function MoveSheet({ appt, onClose, onDone }: { appt: Appt | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState('');
  const [start, setStart] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (appt) { setDate(new Date(appt.startsAt).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })); setStart(timeOf(appt.startsAt)); setError(null); }
  }, [appt]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!appt) return;
    const dur = new Date(appt.endsAt).getTime() - new Date(appt.startsAt).getTime();
    const startsAt = toIso(date, start);
    setBusy(true); setError(null);
    try { await patch(`/api/appointments/${appt.id}`, { startsAt, endsAt: new Date(new Date(startsAt).getTime() + dur).toISOString() }); toast('Consulta reagendada.'); onDone(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <Sheet open={!!appt} title="Reagendar consulta" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p>Paciente: <strong>{appt?.patientName}</strong></p>
        <div className="grid2"><TextInput label="Nova data" type="date" value={date} onChange={setDate} /><TextInput label="Novo horário" type="time" value={start} onChange={setStart} /></div>
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" busy={busy} className="btn-block">Reagendar</Button>
      </form>
    </Sheet>
  );
}
