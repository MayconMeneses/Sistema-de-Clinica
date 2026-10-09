import { useState } from 'react';
import { get, post } from '../api';
import { dateTimeOf, shiftDay, timeOf } from '../format';
import { Button, Empty, ErrorBox, Select, Sheet, Spinner, useLoad } from '../ui';

interface Options { professionals: { id: string; name: string }[]; slotMinutes: number; minNoticeHours: number; maxDaysAhead: number; service: string; remaining: number; today: string }
const WEEKDAY = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const dayLabel = (ymd: string) => `${WEEKDAY[new Date(`${ymd}T12:00:00Z`).getUTCDay()]}, ${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;

/** Autoagendamento: escolhe o profissional, o dia e um horário livre. O servidor confere de novo na hora de gravar. */
export function BookSheet({ open, onClose, onBooked }: { open: boolean; onClose: () => void; onBooked: (when: string) => void }) {
  const opts = useLoad(() => (open ? get<Options>('/api/portal/booking') : Promise.resolve(null)), [open]);
  const [pro, setPro] = useState('');
  const [day, setDay] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const o = opts.data;
  const proId = pro || o?.professionals[0]?.id || '';
  const days = o ? Array.from({ length: Math.min(o.maxDaysAhead, 30) + 1 }, (_, i) => shiftDay(o.today, i)) : [];
  const slots = useLoad(() => (open && proId && day ? get<{ slots: string[] }>(`/api/portal/booking/slots?professionalId=${proId}&date=${day}`) : Promise.resolve({ slots: [] })), [open, proId, day]);

  async function confirm() {
    if (!chosen) return;
    setBusy(true); setError(null);
    try { await post('/api/portal/booking', { professionalId: proId, startsAt: chosen }); onBooked(dateTimeOf(chosen)); setChosen(null); setDay(''); }
    catch (e) { setError((e as Error).message); setChosen(null); slots.reload(); } finally { setBusy(false); }
  }
  return (
    <Sheet open={open} title="Marcar consulta" onClose={onClose}>
      {opts.loading && !o && <Spinner />}
      {opts.error && <ErrorBox message={opts.error} onRetry={opts.reload} />}
      {o && o.remaining === 0 && <Empty title="Limite de marcações">Você já tem o máximo de consultas marcadas pelo portal. Cancele uma ou fale com a clínica.</Empty>}
      {o && o.remaining > 0 && (
        <div className="stack">
          <p className="small muted">{o.service} · {o.slotMinutes} min. Marcações com pelo menos {o.minNoticeHours} h de antecedência.</p>
          <Select label="Profissional" value={proId} onChange={(v) => { setPro(v); setChosen(null); }}>{o.professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          <Select label="Dia" value={day} onChange={(v) => { setDay(v); setChosen(null); }}><option value="">Escolha o dia…</option>{days.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}</Select>
          {day && slots.loading && <Spinner />}
          {day && !slots.loading && slots.data?.slots.length === 0 && <p className="small muted">Sem horários livres neste dia. Tente outro dia.</p>}
          <div className="row" style={{ flexWrap: 'wrap' }} role="group" aria-label="Horários livres">
            {slots.data?.slots.map((s) => <Button key={s} variant={chosen === s ? 'primary' : 'secondary'} className="btn-sm" aria-pressed={chosen === s} onClick={() => setChosen(s)}>{timeOf(s)}</Button>)}
          </div>
          {error && <p className="field-msg error" role="alert">{error}</p>}
          {chosen && <Button busy={busy} className="btn-block" onClick={confirm}>Confirmar {dayLabel(day)} às {timeOf(chosen)}</Button>}
        </div>
      )}
    </Sheet>
  );
}
