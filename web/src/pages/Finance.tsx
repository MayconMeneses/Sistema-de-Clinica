import { useEffect, useState, type FormEvent } from 'react';
import { get, patch, post, type Me } from '../api';
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
      {advanced && can('payables.read') && <Payables canWrite={can('payables.write')} />}
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

const SHEET_TITLE = { open: 'Abrir caixa', close: 'Fechar caixa', withdrawal: 'Registrar sangria', supply: 'Registrar suprimento' } as const;

function CashDesk({ canOperate, onChange }: { canOperate: boolean; onChange: () => void }) {
  const toast = useToast();
  const cur = useLoad(() => get<{ session: CashSession | null; byMethod?: ByMethod[]; expectedCashCents?: string; withdrawalsCents?: string; suppliesCents?: string; adjustments?: { id: string; kind: 'withdrawal' | 'supply'; amountCents: string; reason: string; createdAt: string; createdByName: string | null }[] }>('/api/cash/current'), []);
  const hist = useLoad(() => get<{ sessions: CashSession[] }>('/api/cash/sessions'), []);
  const [sheet, setSheet] = useState<'open' | 'close' | 'withdrawal' | 'supply' | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ expectedCents: string; countedCents: string; differenceCents: string } | null>(null);

  function openSheet(kind: 'open' | 'close' | 'withdrawal' | 'supply') { setSheet(kind); setAmount(''); setNote(''); setError(null); }
  const refresh = () => { cur.reload(); hist.reload(); onChange(); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseMoney(amount === '' ? '0' : amount);
    if (cents === null) { setError('Informe um valor válido, como 150,00.'); return; }
    setBusy(true); setError(null);
    try {
      if (sheet === 'open') { await post('/api/cash/open', { openingCents: cents }); toast('Caixa aberto.'); }
      else if (sheet === 'withdrawal' || sheet === 'supply') {
        if (cents < 1) { setError('Informe um valor maior que zero.'); setBusy(false); return; }
        await post('/api/cash/adjustments', { kind: sheet, amountCents: cents, reason: note });
        toast(sheet === 'withdrawal' ? 'Sangria registrada.' : 'Suprimento registrado.');
      } else { setResult(await post('/api/cash/close', { countedCents: cents, note: note || undefined })); toast('Caixa fechado.'); }
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
          {cur.data.adjustments && cur.data.adjustments.length > 0 && (
            <ul className="list">
              {cur.data.adjustments.map((a) => (
                <li key={a.id} className="list-item row between">
                  <div><strong>{a.kind === 'withdrawal' ? 'Sangria' : 'Suprimento'}</strong><br /><span className="small muted">{a.reason} · {a.createdByName ?? '—'} · {dateTimeOf(a.createdAt)}</span></div>
                  <strong>{a.kind === 'withdrawal' ? '−' : '+'}{brl(a.amountCents)}</strong>
                </li>
              ))}
            </ul>
          )}
          {canOperate && (
            <div className="row">
              <Button variant="secondary" onClick={() => openSheet('supply')}>Suprimento</Button>
              <Button variant="secondary" onClick={() => openSheet('withdrawal')}>Sangria</Button>
              <Button variant="secondary" onClick={() => openSheet('close')}>Fechar caixa</Button>
            </div>
          )}
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
      <Sheet open={sheet !== null} title={SHEET_TITLE[sheet ?? 'open']} onClose={() => setSheet(null)}>
        <form onSubmit={submit} noValidate>
          <TextInput label={sheet === 'open' ? 'Troco inicial em dinheiro (R$)' : sheet === 'close' ? 'Dinheiro contado na gaveta (R$)' : sheet === 'withdrawal' ? 'Valor retirado do caixa (R$)' : 'Valor colocado no caixa (R$)'} value={amount} onChange={setAmount} inputMode="decimal" placeholder="0,00"
            hint={sheet === 'close' ? 'Conte o dinheiro físico. Se houver diferença, explique abaixo.' : undefined} />
          {sheet === 'close' && <TextInput label="Observação (obrigatória se houver diferença)" value={note} onChange={setNote} />}
          {(sheet === 'withdrawal' || sheet === 'supply') && <TextInput label="Motivo" value={note} onChange={setNote} hint={sheet === 'withdrawal' ? 'Exemplo: depósito no banco, pagamento de fornecedor.' : 'Exemplo: reforço de troco.'} />}
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">{SHEET_TITLE[sheet ?? 'open']}</Button>
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


interface Payable {
  id: string; installment: number; installments: number; description: string; supplier: string | null; category: string | null; amountCents: string;
  dueOn: string; status: 'open' | 'paid' | 'canceled'; paidOn: string | null; paidMethod: string | null; paidCents: string | null; cancelReason: string | null; overdue: boolean; daysToDue: number;
}
interface PayablesData { payables: Payable[]; summary: { openCents: string; overdueCents: string; overdueCount: number; dueSoonCents: string; paidThisMonthCents: string } }
const dmy = (iso: string) => iso.split('-').reverse().join('/');
const PAY_METHOD: Record<string, string> = { cash: 'Dinheiro', pix: 'Pix', transfer: 'Transferência', card: 'Cartão', boleto: 'Boleto', other: 'Outro' };

function Payables({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const [filter, setFilter] = useState<'open' | 'paid' | 'canceled'>('open');
  const d = useLoad(() => get<PayablesData>(`/api/payables?status=${filter}`), [filter]);
  const [form, setForm] = useState<'new' | Payable | null>(null);
  const [paying, setPaying] = useState<Payable | null>(null);
  const [canceling, setCanceling] = useState<Payable | null>(null);
  const [f, setF] = useState({ description: '', supplier: '', category: '', amount: '', dueOn: '', installments: '1', method: 'pix', paidCents: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  function openForm(p: 'new' | Payable) {
    setError(null); setForm(p);
    setF((x) => p === 'new' ? { ...x, description: '', supplier: '', category: '', amount: '', dueOn: '', installments: '1' }
      : { ...x, description: p.description, supplier: p.supplier ?? '', category: p.category ?? '', amount: (Number(p.amountCents) / 100).toFixed(2).replace('.', ','), dueOn: p.dueOn, installments: '1' });
  }
  async function run(fn: () => Promise<unknown>, ok: string, close: () => void) {
    setBusy(true); setError(null);
    try { await fn(); toast(ok); close(); d.reload(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  function submitForm(e: FormEvent) {
    e.preventDefault();
    const cents = parseMoney(f.amount);
    if (f.description.trim().length < 2) { setError('Informe a descrição.'); return; }
    if (cents === null || cents < 1) { setError('Informe um valor válido, como 1.250,00.'); return; }
    if (!f.dueOn) { setError('Informe o vencimento.'); return; }
    const n = Number(f.installments);
    if (form === 'new' && (!Number.isInteger(n) || n < 1 || n > 60)) { setError('Parcelas: de 1 a 60.'); return; }
    const body = { description: f.description, supplier: f.supplier || undefined, category: f.category || undefined, amountCents: cents, dueOn: f.dueOn };
    void run(() => (form === 'new' ? post('/api/payables', { ...body, installments: n }) : patch(`/api/payables/${(form as Payable).id}`, body)), 'Conta salva.', () => setForm(null));
  }
  function submitPay(e: FormEvent) {
    e.preventDefault();
    if (!paying) return;
    const paid = f.paidCents.trim() ? parseMoney(f.paidCents) : undefined;
    if (paid === null) { setError('Valor pago inválido.'); return; }
    void run(() => post(`/api/payables/${paying.id}/pay`, { method: f.method, paidCents: paid }), 'Pagamento registrado.', () => setPaying(null));
  }
  function submitCancel(e: FormEvent) {
    e.preventDefault();
    if (!canceling) return;
    void run(() => post(`/api/payables/${canceling.id}/cancel`, { reason: f.reason }), 'Conta cancelada.', () => setCanceling(null));
  }

  const sum = d.data?.summary;
  return (
    <div className="card">
      <div className="row between"><h2>Contas a pagar</h2>{canWrite && <Button className="btn-sm" onClick={() => openForm('new')}>Nova conta</Button>}</div>
      {sum && (
        <div className="stats">
          <div className="stat"><b>{brl(sum.openCents)}</b><span>Em aberto</span></div>
          <div className="stat"><b>{brl(sum.overdueCents)}</b><span>Atrasado ({sum.overdueCount})</span></div>
          <div className="stat"><b>{brl(sum.dueSoonCents)}</b><span>Vence em 7 dias</span></div>
          <div className="stat"><b>{brl(sum.paidThisMonthCents)}</b><span>Pago no mês</span></div>
        </div>
      )}
      <div className="switch" role="group" aria-label="Situação das contas">
        {(['open', 'paid', 'canceled'] as const).map((k) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{k === 'open' ? 'Abertas' : k === 'paid' ? 'Pagas' : 'Canceladas'}</button>)}
      </div>
      {d.loading && !d.data && <Spinner />}
      {d.error && <ErrorBox message={d.error} onRetry={d.reload} />}
      {d.data && d.data.payables.length === 0 && <Empty title={filter === 'open' ? 'Nenhuma conta em aberto' : 'Nada por aqui'} />}
      <ul className="list">
        {d.data?.payables.map((p) => (
          <li key={p.id} className="list-item stack">
            <div className="row between">
              <div><strong>{p.description}</strong>{p.installments > 1 ? ` (${p.installment}/${p.installments})` : ''}<br />
                <span className="small muted">{[p.supplier, p.category].filter(Boolean).join(' · ') || 'Sem fornecedor'} · vence {dmy(p.dueOn)}{p.status === 'paid' && p.paidOn ? ` · pago ${dmy(p.paidOn)} (${PAY_METHOD[p.paidMethod ?? ''] ?? ''})` : ''}{p.cancelReason ? ` · ${p.cancelReason}` : ''}</span></div>
              <div className="stack" style={{ textAlign: 'right' }}>
                <strong>{brl(p.status === 'paid' ? p.paidCents ?? p.amountCents : p.amountCents)}</strong>
                {p.overdue && <Badge tone="bad">Atrasada</Badge>}
                {p.status === 'open' && !p.overdue && p.daysToDue <= 7 && <Badge tone="warn">{p.daysToDue === 0 ? 'Vence hoje' : `Em ${p.daysToDue} dia${p.daysToDue === 1 ? '' : 's'}`}</Badge>}
                {p.status === 'paid' && <Badge tone="ok">Paga</Badge>}
                {p.status === 'canceled' && <Badge>Cancelada</Badge>}
              </div>
            </div>
            {canWrite && p.status === 'open' && (
              <div className="row">
                <Button className="btn-sm" onClick={() => { setError(null); setF((x) => ({ ...x, method: 'pix', paidCents: '' })); setPaying(p); }}>Pagar</Button>
                <Button variant="ghost" className="btn-sm" onClick={() => openForm(p)}>Editar</Button>
                <Button variant="ghost" className="btn-sm" onClick={() => { setError(null); setF((x) => ({ ...x, reason: '' })); setCanceling(p); }}>Cancelar</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="small muted">Pagamento em dinheiro retirado do caixa deve ser lançado também como Sangria.</p>

      <Sheet open={form !== null} title={form === 'new' ? 'Nova conta a pagar' : 'Editar conta'} onClose={() => setForm(null)}>
        <form onSubmit={submitForm} noValidate>
          <TextInput label="Descrição" value={f.description} onChange={set('description')} />
          <div className="grid2"><TextInput label="Fornecedor (opcional)" value={f.supplier} onChange={set('supplier')} /><TextInput label="Categoria (opcional)" value={f.category} onChange={set('category')} /></div>
          <div className="grid2">
            <TextInput label={form === 'new' && Number(f.installments) > 1 ? 'Valor de cada parcela (R$)' : 'Valor (R$)'} value={f.amount} onChange={set('amount')} inputMode="decimal" placeholder="0,00" />
            <Field label="Vencimento">{(id) => <input id={id} type="date" value={f.dueOn} onChange={(e) => set('dueOn')(e.target.value)} />}</Field>
          </div>
          {form === 'new' && <TextInput label="Parcelas" value={f.installments} onChange={set('installments')} inputMode="numeric" hint="Uma conta por mês, a partir do vencimento." />}
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Salvar conta</Button>
        </form>
      </Sheet>

      <Sheet open={paying !== null} title={paying ? `Pagar: ${paying.description}` : ''} onClose={() => setPaying(null)}>
        <form onSubmit={submitPay} noValidate>
          <p className="small muted">Valor da conta: {paying ? brl(paying.amountCents) : ''}</p>
          <Field label="Forma de pagamento">{(id) => <select id={id} value={f.method} onChange={(e) => set('method')(e.target.value)}>{Object.entries(PAY_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
          <TextInput label="Valor pago (R$, se diferente)" value={f.paidCents} onChange={set('paidCents')} inputMode="decimal" hint="Deixe vazio para o valor da conta. Use se houve juros ou desconto." />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Confirmar pagamento</Button>
        </form>
      </Sheet>

      <Sheet open={canceling !== null} title="Cancelar conta" onClose={() => setCanceling(null)}>
        <form onSubmit={submitCancel} noValidate>
          <p>Cancelar <strong>{canceling?.description}</strong>? A conta fica registrada como cancelada e não pode ser reaberta.</p>
          <TextInput label="Motivo" value={f.reason} onChange={set('reason')} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" variant="danger" busy={busy} className="btn-block">Cancelar conta</Button>
        </form>
      </Sheet>
    </div>
  );
}
