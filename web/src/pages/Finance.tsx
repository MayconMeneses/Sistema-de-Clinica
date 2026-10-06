import { useEffect, useState } from 'react';
import { get } from '../api';
import { brl, METHOD_LABEL } from '../format';
import { Empty, ErrorBox, Field, Spinner, useLoad } from '../ui';

export function FinancePage() {
  const s = useLoad(() => get<{ outstandingCents: string; receivedToday: { method: string; total: string }[] }>('/api/finance/summary'), []);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const found = useLoad(() => (debounced.length >= 2 ? get<{ patients: { id: string; name: string }[] }>(`/api/patients?q=${encodeURIComponent(debounced)}`) : Promise.resolve({ patients: [] })), [debounced]);
  const total = s.data?.receivedToday.reduce((acc, r) => acc + BigInt(r.total), 0n) ?? 0n;

  return (
    <>
      <div className="page-head"><h1>Financeiro</h1></div>
      {s.loading && !s.data && <Spinner />}
      {s.error && <ErrorBox message={s.error} onRetry={s.reload} />}
      {s.data && (
        <div className="stats">
          <div className="stat"><b>{brl(total.toString())}</b><span>Recebido hoje</span></div>
          <div className="stat"><b>{brl(s.data.outstandingCents)}</b><span>Em aberto (todos)</span></div>
          {s.data.receivedToday.map((r) => <div className="stat" key={r.method}><b>{brl(r.total)}</b><span>{METHOD_LABEL[r.method]} hoje</span></div>)}
        </div>
      )}
      <div className="card">
        <h2>Lançar para um paciente</h2>
        <Field label="Buscar paciente" hint="Cobranças, pagamentos e estornos ficam na aba Financeiro da ficha do paciente.">
          {(id, d) => <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-describedby={d} autoComplete="off" />}
        </Field>
        {debounced.length >= 2 && found.data?.patients.length === 0 && !found.loading && <Empty title="Nenhum paciente encontrado" />}
        <ul className="list">
          {found.data?.patients.map((p) => <li key={p.id}><a className="list-item link" href={`#/pacientes/${p.id}`}>{p.name}</a></li>)}
        </ul>
      </div>
    </>
  );
}
