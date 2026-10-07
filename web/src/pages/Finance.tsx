import { useEffect, useState, type FormEvent } from 'react';
import { get, post, type Me } from '../api';
import { brl, dateTimeOf, METHOD_LABEL, parseMoney } from '../format';
import { Badge, Button, Empty, ErrorBox, Field, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

interface CashSession {
  id: string; openedAt: string; openingCents: string; closedAt: string | null; expectedCents: string | null;
  countedCents: string | null; differenceCents: string | null; closeNote: string | null; openedByName: string | null; closedByName: string | null;
}
interface ByMethod { method: string; receivedCents: string; refundedCents: string; count: number }
interface DiscountRequest {
  id: string; patientId: string; patientName: string; amountCents: string; reason: string; status: 'pending' | 'approved' | 'rejected';
  requestedAt: string; requestedByName: string | null; decidedAt: string | null; decidedByName: string | null; decisionNote: string | null;
}

export function FinancePage({ me }: { me: Me }) {
  const advanced = me.entitlements.includes('finance.advanced');
  const can = (p: string) => me.permissions.includes(p);
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
      {advanced && <CashDesk canOperate={can('cash.operate')} onChange={s.reload} />}
      {advanced && <Discounts canApprove={can('finance.approve')} onChange={s.reload} />}
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

function CashDesk({ canOperate, onChange }: { canOperate: boolean; onChange: () => void }) {
  const toast = useToast();
  const cur = useLoad(() => get<{ session: CashSession | null; byMethod?: ByMethod[]; expectedCashCents?: string }>('/api/cash/current'), []);
  const hist = useLoad(() => get<{ sessions: CashSession[] }>('/api/cash/sessions'), []);
  const [sheet, setSheet] = useState<'open' | 'close' | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ expectedCents: string; countedCents: string; differenceCents: string } | null>(null);

  function openSheet(kind: 'open' | 'close') { setSheet(kind); setAmount(''); setNote(''); setError(null); }
  const refresh = () => { cur.reload(); hist.reload(); onChange(); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseMoney(amount === '' ? '0' : amount);
    if (cents === null) { setError('Informe um valor válido, como 150,00.'); return; }
    setBusy(true); setError(null);
    try {
      if (sheet === 'open') { await post('/api/cash/open', { openingCents: cents }); toast('Caixa aberto.'); }
      else { setResult(await post('/api/cash/close', { countedCents: cents, note: note || undefined })); toast('Caixa fechado.'); }
      setSheet(null); refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const session = cur.data?.session;
  return (
    <div className="card">
      <div className="row between">
        <h2>Caixa</h2>
        {cur.data && <Badge tone={session ? 'ok' : 'neutral'}>{session ? 'Aberto' : 'Fechado'}</Badge>}
      </div>
      {cur.loading && !cur.data && <Spinner />}
      {cur.error && <ErrorBox message={cur.error} onRetry={cur.reload} />}
      {cur.data && !session && (
        <>
          <p className="muted">Com o caixa fechado, recebimentos em dinheiro não podem ser registrados. Pix e cartão seguem normalmente.</p>
          {canOperate && <Button onClick={() => openSheet('open')}>Abrir caixa</Button>}
        </>
      )}
      {session && cur.data && (
        <div className="stack">
          <p className="small muted">Aberto por {session.openedByName ?? '—'} em {dateTimeOf(session.openedAt)} com {brl(session.openingCents)}.</p>
          <div className="stats">
            <div className="stat"><b>{brl(cur.data.expectedCashCents ?? '0')}</b><span>Dinheiro esperado</span></div>
            {cur.data.byMethod?.map((m) => <div className="stat" key={m.method}><b>{brl((BigInt(m.receivedCents) - BigInt(m.refundedCents)).toString())}</b><span>{METHOD_LABEL[m.method]} no caixa ({m.count})</span></div>)}
          </div>
          {canOperate && <div><Button variant="secondary" onClick={() => openSheet('close')}>Fechar caixa</Button></div>}
        </div>
      )}
      {result && (
        <div className="banner" role="status">
          Caixa fechado. Esperado {brl(result.expectedCents)}, contado {brl(result.countedCents)}
          {BigInt(result.differenceCents) === 0n ? ': sem diferença.' : `, diferença de ${brl(result.differenceCents)}.`}
        </div>
      )}
      {hist.data && hist.data.sessions.some((x) => x.closedAt) && (
        <>
          <h3>Caixas anteriores</h3>
          <ul className="list">
            {hist.data.sessions.filter((x) => x.closedAt).slice(0, 5).map((x) => (
              <li key={x.id} className="list-item row between">
                <div><strong>{dateTimeOf(x.openedAt)}</strong><br /><span className="small muted">{x.closedByName ?? '—'} · contado {brl(x.countedCents ?? '0')}{x.closeNote ? ` · ${x.closeNote}` : ''}</span></div>
                {x.differenceCents === '0' ? <Badge tone="ok">Sem diferença</Badge> : <Badge tone="warn">{brl(x.differenceCents ?? '0')}</Badge>}
              </li>
            ))}
          </ul>
        </>
      )}
      <Sheet open={sheet !== null} title={sheet === 'open' ? 'Abrir caixa' : 'Fechar caixa'} onClose={() => setSheet(null)}>
        <form onSubmit={submit} noValidate>
          <TextInput label={sheet === 'open' ? 'Troco inicial em dinheiro (R$)' : 'Dinheiro contado na gaveta (R$)'} value={amount} onChange={setAmount} inputMode="decimal" placeholder="0,00"
            hint={sheet === 'close' ? 'Conte o dinheiro físico. Se houver diferença, explique abaixo.' : undefined} />
          {sheet === 'close' && <TextInput label="Observação (obrigatória se houver diferença)" value={note} onChange={setNote} />}
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">{sheet === 'open' ? 'Abrir caixa' : 'Fechar caixa'}</Button>
        </form>
      </Sheet>
    </div>
  );
}

function Discounts({ canApprove, onChange }: { canApprove: boolean; onChange: () => void }) {
  const toast = useToast();
  const list = useLoad(() => get<{ requests: DiscountRequest[] }>('/api/finance/discount-requests'), []);
  const [rejecting, setRejecting] = useState<DiscountRequest | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(r: DiscountRequest, decision: 'approve' | 'reject', n?: string) {
    setBusy(r.id); setError(null);
    try {
      await post(`/api/finance/discount-requests/${r.id}/decide`, { decision, note: n || undefined });
      toast(decision === 'approve' ? 'Desconto aprovado.' : 'Pedido recusado.');
      setRejecting(null); setNote(''); list.reload(); onChange();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  const pending = list.data?.requests.filter((r) => r.status === 'pending') ?? [];
  const decided = list.data?.requests.filter((r) => r.status !== 'pending').slice(0, 5) ?? [];
  return (
    <div className="card">
      <h2>Descontos</h2>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {error && !rejecting && <p className="field-msg error" role="alert">{error}</p>}
      {list.data && pending.length === 0 && <p className="muted">Nenhum pedido aguardando aprovação. Peça um desconto na aba Financeiro da ficha do paciente.</p>}
      <ul className="list">
        {pending.map((r) => (
          <li key={r.id} className="list-item stack">
            <div className="row between">
              <div><a href={`#/pacientes/${r.patientId}`}><strong>{r.patientName}</strong></a><br /><span className="small muted">{r.reason} · pedido por {r.requestedByName ?? '—'} em {dateTimeOf(r.requestedAt)}</span></div>
              <strong>{brl(r.amountCents)}</strong>
            </div>
            {canApprove && (
              <div className="row">
                <Button busy={busy === r.id} onClick={() => decide(r, 'approve')}>Aprovar</Button>
                <Button variant="secondary" disabled={busy === r.id} onClick={() => { setRejecting(r); setNote(''); setError(null); }}>Recusar</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {decided.length > 0 && (
        <>
          <h3>Decididos recentemente</h3>
          <ul className="list">
            {decided.map((r) => (
              <li key={r.id} className="list-item row between">
                <div><strong>{r.patientName}</strong><br /><span className="small muted">{brl(r.amountCents)} · {r.decidedByName ?? '—'}{r.decisionNote ? ` · ${r.decisionNote}` : ''}</span></div>
                <Badge tone={r.status === 'approved' ? 'ok' : 'bad'}>{r.status === 'approved' ? 'Aprovado' : 'Recusado'}</Badge>
              </li>
            ))}
          </ul>
        </>
      )}
      <Sheet open={rejecting !== null} title="Recusar desconto" onClose={() => setRejecting(null)}>
        <form onSubmit={(e) => { e.preventDefault(); if (rejecting) void decide(rejecting, 'reject', note); }} noValidate>
          <TextInput label="Motivo da recusa" value={note} onChange={setNote} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" variant="danger" busy={busy !== null} className="btn-block">Recusar pedido</Button>
        </form>
      </Sheet>
    </div>
  );
}
