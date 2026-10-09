import { useState } from 'react';
import { downloadFile, get } from '../api';
import { brl, METHOD_LABEL, shiftDay, todayYmd } from '../format';
import { Badge, Button, ErrorBox, Spinner, TextInput, useLoad, useToast } from '../ui';

interface Overview {
  period: { from: string; to: string };
  omitted: { section: string; reason: string }[];
  sections: {
    appointments?: { total: number; byStatus: Record<string, number>; noShowRate: number | null; byProfessional: { name: string; total: number; completed: number; noShow: number; cancelled: number }[] };
    patients?: { newPatients: number; totalActive: number };
    finance?: { chargedCents: string; receivedCents: string; refundedCents: string; discountsCents: string; outstandingCents: string; byMethod: { method: string; receivedCents: string }[]; cash?: { closedSessions: number; differenceCents: string; pendingDiscounts: number } };
    crm?: { created: number; byStage: Record<string, number>; bySource: { source: string; n: number; won: number }[]; conversionRate: number | null };
    inventory?: { activeItems: number; lowStock: number; entries: number; exits: number };
  };
}
const SECTION_LABEL: Record<string, string> = { appointments: 'Atendimentos', patients: 'Pacientes', finance: 'Financeiro', crm: 'CRM', inventory: 'Estoque' };
const SOURCE: Record<string, string> = { referral: 'Indicação', instagram: 'Instagram', google: 'Google', website: 'Site', whatsapp: 'WhatsApp', walk_in: 'Visita', other: 'Outro' };
const STATUS: Record<string, string> = { completed: 'Concluídas', scheduled: 'Agendadas', confirmed: 'Confirmadas', checked_in: 'Na recepção', called: 'Chamadas', in_service: 'Em atendimento', cancelled: 'Canceladas', no_show: 'Faltas' };
const pct = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

function Stat({ value, label }: { value: string | number; label: string }) { return <div className="stat"><b>{value}</b><span>{label}</span></div>; }
function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="list">
      {rows.map((r) => (
        <li key={r.label} className="barrow"><span className="small">{r.label}</span><meter min={0} max={max} value={r.value} aria-label={`${r.label}: ${r.value}`} /><strong className="small">{r.value}</strong></li>
      ))}
    </ul>
  );
}

interface Compare { months: string[]; indicators: { key: string; label: string; unit: 'qtd' | 'R$' | '%'; values: (number | null)[] }[] }
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]}/${ym.slice(2, 4)}`;
const fmtVal = (v: number | null, unit: 'qtd' | 'R$' | '%') => (v === null ? '—' : unit === 'R$' ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : unit === '%' ? pct(v) : v.toLocaleString('pt-BR'));

/** Colunas mês a mês do mesmo indicador, com uma linha ligando o topo das colunas e a variação sobre o mês anterior. */
function MonthCompare() {
  const [months, setMonths] = useState(6);
  const [key, setKey] = useState('appointments');
  const data = useLoad(() => get<Compare>(`/api/reports/compare?months=${months}`), [months]);
  const ind = data.data?.indicators.find((i) => i.key === key) ?? data.data?.indicators[0];
  const W = 640, H = 220, padL = 8, padB = 28, padT = 26;
  const vals = ind?.values ?? [];
  const max = Math.max(1, ...vals.map((v) => v ?? 0));
  const n = vals.length || 1, slot = (W - padL * 2) / n, bw = Math.min(56, slot * 0.6);
  const x = (i: number) => padL + slot * i + slot / 2;
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const line = vals.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ');
  const delta = (i: number) => {
    const a = vals[i - 1], b = vals[i];
    if (i === 0 || a == null || b == null) return null;
    if (ind!.unit === '%') return { text: `${b - a >= 0 ? '+' : ''}${(b - a).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} p.p.`, up: b >= a };
    if (a === 0) return null;
    const d = ((b - a) / a) * 100;
    return { text: `${d >= 0 ? '+' : ''}${d.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`, up: d >= 0 };
  };
  return (
    <section className="card stack" aria-labelledby="r-cmp">
      <div className="row between"><h2 id="r-cmp">Comparar meses</h2>
        <span className="row">
          <select aria-label="Indicador" className="input" value={ind?.key ?? key} onChange={(e) => setKey(e.target.value)}>{data.data?.indicators.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select>
          <select aria-label="Quantidade de meses" className="input" value={months} onChange={(e) => setMonths(Number(e.target.value))}>{[3, 6, 12].map((m) => <option key={m} value={m}>{m} meses</option>)}</select>
        </span></div>
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.data && !ind && <p className="small muted">Nenhum indicador disponível para o seu plano ou perfil.</p>}
      {data.data && ind && (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${ind.label} por mês`} className="chart">
            {vals.map((v, i) => v === null ? null : (
              <g key={i}>
                <rect x={x(i) - bw / 2} y={y(v)} width={bw} height={Math.max(1, H - padB - y(v))} rx={3} fill="var(--primary, #2563eb)" opacity={i === vals.length - 1 ? 1 : 0.7} />
                <text x={x(i)} y={y(v) - 6} textAnchor="middle" fontSize="11" fill="currentColor">{fmtVal(v, ind.unit)}</text>
              </g>
            ))}
            {line && <polyline points={line} fill="none" stroke="var(--warn, #d97706)" strokeWidth="2" />}
            {vals.map((v, i) => v === null ? null : <circle key={`c${i}`} cx={x(i)} cy={y(v)} r={3.5} fill="var(--warn, #d97706)" />)}
            {data.data!.months.map((m, i) => <text key={m} x={x(i)} y={H - 8} textAnchor="middle" fontSize="12" fill="currentColor">{monthLabel(m)}</text>)}
          </svg>
          <table className="table small">
            <thead><tr><th>Mês</th><th>{ind.label}</th><th>Variação</th></tr></thead>
            <tbody>{data.data.months.map((m, i) => { const d = delta(i); return (
              <tr key={m}><td>{monthLabel(m)}</td><td>{fmtVal(vals[i] ?? null, ind.unit)}</td><td>{d ? <span style={{ color: d.up ? 'var(--ok, #15803d)' : 'var(--bad, #b91c1c)' }}>{d.up ? '▲' : '▼'} {d.text}</span> : '—'}</td></tr>
            ); })}</tbody>
          </table>
          <p className="small muted">O mês atual está em andamento. Variação sobre o mês anterior (taxas em pontos percentuais).</p>
        </>
      )}
    </section>
  );
}

export function ReportsPage() {
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const today = todayYmd();
  const [range, setRange] = useState({ from: shiftDay(today, -29), to: today });
  const data = useLoad(() => get<Overview>(`/api/reports/overview?from=${range.from}&to=${range.to}`), [range.from, range.to]);
  const set = (from: string, to: string) => setRange({ from, to });
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevMonthEnd = shiftDay(monthStart, -1);

  const s = data.data?.sections;
  return (
    <>
      <div className="page-head">
        <h1>Indicadores</h1>
        <Button variant="secondary" busy={exporting} onClick={async () => {
          setExporting(true);
          try { await downloadFile(`/api/reports/export?from=${range.from}&to=${range.to}`, `indicadores-${range.from}_${range.to}.csv`); toast('Arquivo gerado.'); }
          catch (err) { toast((err as Error).message, 'bad'); } finally { setExporting(false); }
        }}>Exportar CSV</Button>
      </div>
      <div className="card stack">
        <div className="row">
          <Button variant="secondary" className="btn-sm" onClick={() => set(today, today)}>Hoje</Button>
          <Button variant="secondary" className="btn-sm" onClick={() => set(shiftDay(today, -6), today)}>7 dias</Button>
          <Button variant="secondary" className="btn-sm" onClick={() => set(shiftDay(today, -29), today)}>30 dias</Button>
          <Button variant="secondary" className="btn-sm" onClick={() => set(monthStart, today)}>Este mês</Button>
          <Button variant="secondary" className="btn-sm" onClick={() => set(`${prevMonthEnd.slice(0, 7)}-01`, prevMonthEnd)}>Mês passado</Button>
        </div>
        <div className="grid2">
          <TextInput label="De" type="date" value={range.from} onChange={(v) => v && setRange({ ...range, from: v })} />
          <TextInput label="Até" type="date" value={range.to} onChange={(v) => v && setRange({ ...range, to: v })} />
        </div>
      </div>
      <MonthCompare />
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.data && data.data.omitted.length > 0 && (
        <p className="small muted" role="note">Não exibido: {data.data.omitted.map((o) => `${SECTION_LABEL[o.section] ?? o.section} (${o.reason})`).join('; ')}.</p>
      )}

      {s?.appointments && (
        <section className="card" aria-labelledby="r-ag"><h2 id="r-ag">Atendimentos</h2>
          <div className="stats">
            <Stat value={s.appointments.total} label="Consultas no período" />
            <Stat value={s.appointments.byStatus.completed ?? 0} label="Concluídas" />
            <Stat value={s.appointments.byStatus.no_show ?? 0} label="Faltas" />
            <Stat value={pct(s.appointments.noShowRate)} label="Taxa de falta" />
          </div>
          <p className="small muted">Taxa de falta = faltas ÷ (concluídas + faltas).</p>
          {s.appointments.total > 0 && <Bars rows={Object.entries(s.appointments.byStatus).map(([k, v]) => ({ label: STATUS[k] ?? k, value: v }))} />}
          {s.appointments.byProfessional.length > 0 && (<><h3>Por profissional</h3>
            <ul className="list">{s.appointments.byProfessional.map((p) => <li key={p.name} className="list-item row between"><strong>{p.name}</strong><span className="small">{p.total} consultas · {p.completed} concluídas · {p.noShow} faltas</span></li>)}</ul></>)}
        </section>
      )}
      {s?.patients && (
        <section className="card" aria-labelledby="r-pa"><h2 id="r-pa">Pacientes</h2>
          <div className="stats"><Stat value={s.patients.newPatients} label="Novos no período" /><Stat value={s.patients.totalActive} label="Cadastros ativos" /></div>
        </section>
      )}
      {s?.finance && (
        <section className="card" aria-labelledby="r-fi"><h2 id="r-fi">Financeiro</h2>
          <div className="stats">
            <Stat value={brl(s.finance.chargedCents)} label="Cobrado" /><Stat value={brl(s.finance.receivedCents)} label="Recebido (líquido)" />
            <Stat value={brl(s.finance.discountsCents)} label="Descontos" /><Stat value={brl(s.finance.outstandingCents)} label="Em aberto hoje" />
          </div>
          <ul className="list">{s.finance.byMethod.map((m) => <li key={m.method} className="list-item row between"><span>{METHOD_LABEL[m.method]}</span><strong>{brl(m.receivedCents)}</strong></li>)}</ul>
          {s.finance.cash && <p className="small">Caixas fechados no período: <strong>{s.finance.cash.closedSessions}</strong> · diferença acumulada: <strong>{brl(s.finance.cash.differenceCents)}</strong>{s.finance.cash.pendingDiscounts > 0 && <> · <Badge tone="warn">{s.finance.cash.pendingDiscounts} desconto(s) aguardando aprovação</Badge></>}</p>}
        </section>
      )}
      {s?.crm && (
        <section className="card" aria-labelledby="r-cr"><h2 id="r-cr">CRM</h2>
          <div className="stats"><Stat value={s.crm.created} label="Leads novos" /><Stat value={s.crm.byStage.won ?? 0} label="Viraram paciente" /><Stat value={pct(s.crm.conversionRate)} label="Conversão" /></div>
          <p className="small muted">Conversão = leads do período que viraram paciente ÷ leads do período.</p>
          {s.crm.bySource.length > 0 && <Bars rows={s.crm.bySource.map((x) => ({ label: `${SOURCE[x.source] ?? x.source} (${x.won} ganhos)`, value: x.n }))} />}
        </section>
      )}
      {s?.inventory && (
        <section className="card" aria-labelledby="r-es"><h2 id="r-es">Estoque</h2>
          <div className="stats"><Stat value={s.inventory.activeItems} label="Itens ativos" /><Stat value={s.inventory.lowStock} label="No mínimo ou abaixo" /><Stat value={s.inventory.entries} label="Entradas no período" /><Stat value={s.inventory.exits} label="Saídas no período" /></div>
        </section>
      )}
    </>
  );
}
