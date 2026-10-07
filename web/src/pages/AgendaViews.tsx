import { dayRange, shiftDay, STATUS_LABEL, timeOf, todayYmd } from '../format';
import { Badge } from '../ui';

const TZ = 'America/Sao_Paulo';
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'bad' | 'info'> = { scheduled: 'neutral', confirmed: 'info', checked_in: 'warn', called: 'info', in_service: 'info', completed: 'ok', cancelled: 'bad', no_show: 'bad' };

interface Appt { id: string; startsAt: string; endsAt: string; status: string; service: string; patientId: string; patientName: string; professionalName: string }
interface Block { id: string; startsAt: string; endsAt: string; reason: string }

/** 0 = domingo. Calculado sobre a data (AAAA-MM-DD), sem depender do fuso do navegador. */
export const weekdayOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
/** A semana começa no domingo (calendário brasileiro). */
export const weekStartOf = (ymd: string) => shiftDay(ymd, -weekdayOf(ymd));
/** Primeiro dia do mês, `n` meses à frente (ou atrás). */
export function shiftMonth(ymd: string, n: number): string {
  const [y, m] = ymd.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
}
const dayOfStart = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const short = (ymd: string) => ymd.split('-').reverse().slice(0, 2).join('/');
const hasBlock = (blocks: Block[], ymd: string) => {
  const r = dayRange(ymd);
  return blocks.some((b) => new Date(b.startsAt) < new Date(r.to) && new Date(b.endsAt) > new Date(r.from));
};

export function WeekView({ weekStart, appointments, blocks, onOpenDay }: { weekStart: string; appointments: Appt[]; blocks: Block[]; onOpenDay: (ymd: string) => void }) {
  const today = todayYmd();
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(weekStart, i));
  return (
    <div className="weekgrid">
      {days.map((d) => {
        const items = appointments.filter((a) => dayOfStart(a.startsAt) === d);
        return (
          <section key={d} className={`weekday${d === today ? ' today' : ''}`} aria-label={`${WEEKDAYS[weekdayOf(d)]} ${short(d)}`}>
            <button type="button" className="weekday-head" onClick={() => onOpenDay(d)} aria-label={`Abrir ${WEEKDAYS[weekdayOf(d)]} ${short(d)}: ${items.length} consulta${items.length === 1 ? '' : 's'}`}>
              <strong>{WEEKDAYS[weekdayOf(d)]} {short(d)}</strong>
              <span className="small muted">{items.length === 0 ? 'livre' : `${items.length}`}</span>
            </button>
            {hasBlock(blocks, d) && <p className="small"><Badge tone="warn">Bloqueio</Badge></p>}
            <ul className="list">
              {items.map((a) => (
                <li key={a.id} className="weekitem">
                  <span className="appt-time">{timeOf(a.startsAt)}</span>
                  <a href={`#/pacientes/${a.patientId}`}>{a.patientName}</a>
                  <span className="small muted">{a.professionalName}</span>
                  <Badge tone={TONE[a.status] ?? 'neutral'}>{STATUS_LABEL[a.status]}</Badge>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function MonthGrid({ monthStart, days, blocks, onOpenDay }: { monthStart: string; days: { day: string; active: number; completed: number; lost: number }[]; blocks: Block[]; onOpenDay: (ymd: string) => void }) {
  const today = todayYmd();
  const next = shiftMonth(monthStart, 1);
  const count = Math.round((new Date(`${next}T12:00:00Z`).getTime() - new Date(`${monthStart}T12:00:00Z`).getTime()) / 86400000);
  const byDay = new Map(days.map((d) => [d.day, d]));
  const cells: (string | null)[] = [...Array(weekdayOf(monthStart)).fill(null), ...Array.from({ length: count }, (_, i) => shiftDay(monthStart, i))];
  return (
    <div className="monthgrid" role="group" aria-label="Calendário do mês">
      {WEEKDAYS.map((w) => <span key={w} className="month-wd small muted" aria-hidden="true">{w}</span>)}
      {cells.map((d, i) => {
        if (!d) return <span key={`b${i}`} aria-hidden="true" />;
        const s = byDay.get(d);
        const n = s?.active ?? 0;
        return (
          <button key={d} type="button" className={`month-cell${d === today ? ' today' : ''}${n > 0 ? ' busy' : ''}`} onClick={() => onOpenDay(d)}
            aria-label={`${Number(d.slice(8))} de ${new Date(`${d}T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', timeZone: 'UTC' })}: ${n === 0 ? 'sem consultas' : `${n} consulta${n === 1 ? '' : 's'}`}${hasBlock(blocks, d) ? ', com bloqueio' : ''}`}>
            <span className="month-num">{Number(d.slice(8))}</span>
            {n > 0 && <span className="month-count">{n}</span>}
            {hasBlock(blocks, d) && <span className="month-block" aria-hidden="true">⛔</span>}
          </button>
        );
      })}
    </div>
  );
}
