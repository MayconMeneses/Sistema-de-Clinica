import { useState, type FormEvent } from 'react';
import { get, patch, post, put } from '../api';
import { brl, dateTimeOf, parseMoney } from '../format';
import { Badge, Button, Empty, ErrorBox, Field, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

interface Supplier { id: string; name: string; phone: string | null; email: string | null; notes: string | null; active: boolean }
interface Order { id: string; number: number; status: 'draft' | 'sent' | 'partial' | 'received' | 'canceled'; expectedOn: string | null; note: string | null; cancelReason: string | null; supplierId: string; supplierName: string; totalCents: string; lineCount: number; createdAt: string; createdByName: string | null }
interface Line { id: string; itemId: string; itemName: string; unit: string; quantity: string; unitCostCents: string; received: string }
interface ItemOpt { id: string; name: string; unit: string }
const STATUS: Record<Order['status'], { label: string; tone: 'neutral' | 'ok' | 'warn' | 'info' | 'bad' }> = {
  draft: { label: 'Rascunho', tone: 'neutral' }, sent: { label: 'Enviado', tone: 'info' }, partial: { label: 'Recebido em parte', tone: 'warn' }, received: { label: 'Recebido', tone: 'ok' }, canceled: { label: 'Cancelado', tone: 'bad' },
};
const dmy = (iso: string) => iso.split('-').reverse().join('/');
const fmt = (v: string) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const parseQty = (s: string): number | null => { const t = s.trim().replace(',', '.'); return /^\d+(\.\d{1,3})?$/.test(t) && Number(t) > 0 ? Number(t) : null; };

export function Purchasing({ open, onClose, canWrite, onChanged }: { open: 'suppliers' | 'orders' | null; onClose: () => void; canWrite: boolean; onChanged: () => void }) {
  return (
    <>
      <SuppliersSheet open={open === 'suppliers'} onClose={onClose} canWrite={canWrite} />
      <OrdersSheet open={open === 'orders'} onClose={onClose} canWrite={canWrite} onChanged={onChanged} />
    </>
  );
}

function SuppliersSheet({ open, onClose, canWrite }: { open: boolean; onClose: () => void; canWrite: boolean }) {
  const toast = useToast();
  const list = useLoad(() => (open ? get<{ suppliers: Supplier[] }>('/api/suppliers?includeInactive=1') : Promise.resolve({ suppliers: [] as Supplier[] })), [open]);
  const [edit, setEdit] = useState<Supplier | 'new' | null>(null);
  const [f, setF] = useState({ name: '', phone: '', email: '', notes: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openEdit = (s: Supplier | 'new') => { setError(null); setEdit(s); setF(s === 'new' ? { name: '', phone: '', email: '', notes: '' } : { name: s.name, phone: s.phone ?? '', email: s.email ?? '', notes: s.notes ?? '' }); };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (f.name.trim().length < 2) { setError('Informe o nome do fornecedor.'); return; }
    setBusy(true); setError(null);
    try {
      if (edit === 'new') await post('/api/suppliers', { name: f.name, phone: f.phone || undefined, email: f.email || undefined, notes: f.notes || undefined });
      else if (edit) await patch(`/api/suppliers/${edit.id}`, { name: f.name, phone: f.phone, email: f.email, notes: f.notes });
      toast('Fornecedor salvo.'); setEdit(null); list.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function toggle(s: Supplier) {
    try { await patch(`/api/suppliers/${s.id}`, { active: !s.active }); toast(s.active ? 'Fornecedor inativado.' : 'Fornecedor reativado.'); list.reload(); } catch (err) { toast((err as Error).message, 'bad'); }
  }
  return (
    <>
      <Sheet open={open} title="Fornecedores" onClose={onClose}>
        {canWrite && <Button className="btn-block" onClick={() => openEdit('new')}>Novo fornecedor</Button>}
        {list.loading && !list.data && <Spinner />}
        {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
        {list.data?.suppliers.length === 0 && <Empty title="Nenhum fornecedor cadastrado" />}
        <ul className="list">
          {list.data?.suppliers.map((s) => (
            <li key={s.id} className="list-item stack">
              <div className="row between"><strong>{s.name}</strong>{!s.active && <Badge>Inativo</Badge>}</div>
              <span className="small muted">{[s.phone, s.email, s.notes].filter(Boolean).join(' · ') || 'Sem contato'}</span>
              {canWrite && <div className="row"><Button variant="ghost" className="btn-sm" onClick={() => openEdit(s)}>Editar</Button><Button variant="ghost" className="btn-sm" onClick={() => toggle(s)}>{s.active ? 'Inativar' : 'Reativar'}</Button></div>}
            </li>
          ))}
        </ul>
      </Sheet>
      <Sheet open={edit !== null} title={edit === 'new' ? 'Novo fornecedor' : 'Editar fornecedor'} onClose={() => setEdit(null)}>
        <form onSubmit={save} noValidate>
          <TextInput label="Nome" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
          <div className="grid2"><TextInput label="Telefone" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} /><TextInput label="E-mail" type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} /></div>
          <TextInput label="Observações" value={f.notes} onChange={(v) => setF({ ...f, notes: v })} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Salvar fornecedor</Button>
        </form>
      </Sheet>
    </>
  );
}

interface FormLine { itemId: string; qty: string; cost: string }

function OrdersSheet({ open, onClose, canWrite, onChanged }: { open: boolean; onClose: () => void; canWrite: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [filter, setFilter] = useState<'open' | 'received' | 'canceled'>('open');
  const list = useLoad(() => (open ? get<{ orders: Order[] }>(`/api/purchase-orders?status=${filter}`) : Promise.resolve({ orders: [] as Order[] })), [open, filter]);
  const [form, setForm] = useState<{ id: string | null } | null>(null);
  const [view, setView] = useState<string | null>(null);
  const reload = () => { list.reload(); onChanged(); };
  return (
    <>
      <Sheet open={open} title="Pedidos de compra" onClose={onClose}>
        {canWrite && <Button className="btn-block" onClick={() => setForm({ id: null })}>Novo pedido</Button>}
        <div className="switch" role="group" aria-label="Situação dos pedidos">
          {(['open', 'received', 'canceled'] as const).map((k) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{k === 'open' ? 'Em andamento' : k === 'received' ? 'Recebidos' : 'Cancelados'}</button>)}
        </div>
        {list.loading && !list.data && <Spinner />}
        {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
        {list.data?.orders.length === 0 && <Empty title="Nenhum pedido aqui" />}
        <ul className="list">
          {list.data?.orders.map((o) => (
            <li key={o.id} className="list-item stack">
              <div className="row between"><strong>Pedido nº {o.number}</strong><Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge></div>
              <span className="small muted">{o.supplierName} · {o.lineCount} item(ns) · {brl(o.totalCents)}{o.expectedOn ? ` · previsto ${dmy(o.expectedOn)}` : ''}</span>
              <div><Button variant="secondary" className="btn-sm" onClick={() => setView(o.id)}>Abrir</Button></div>
            </li>
          ))}
        </ul>
      </Sheet>
      <OrderForm state={form} onClose={() => setForm(null)} onSaved={() => { setForm(null); reload(); }} toast={toast} />
      <OrderView id={view} canWrite={canWrite} onClose={() => setView(null)} onChanged={reload} onEdit={(id) => { setView(null); setForm({ id }); }} />
    </>
  );
}

function OrderForm({ state, onClose, onSaved, toast }: { state: { id: string | null } | null; onClose: () => void; onSaved: () => void; toast: (m: string, t?: 'ok' | 'bad') => void }) {
  const suppliers = useLoad(() => (state ? get<{ suppliers: Supplier[] }>('/api/suppliers') : Promise.resolve({ suppliers: [] as Supplier[] })), [!!state]);
  const items = useLoad(() => (state ? get<{ items: ItemOpt[] }>('/api/inventory/items') : Promise.resolve({ items: [] as ItemOpt[] })), [!!state]);
  const existing = useLoad(() => (state?.id ? get<{ order: Order; lines: Line[] }>(`/api/purchase-orders/${state.id}`) : Promise.resolve(null)), [state?.id]);
  const [supplierId, setSupplierId] = useState('');
  const [expected, setExpected] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<FormLine[]>([{ itemId: '', qty: '', cost: '' }]);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Preenche o formulário uma vez por abertura (novo ou edição de rascunho).
  const key = state ? (state.id ?? 'new') : null;
  if (key !== loadedFor && state && (!state.id || existing.data)) {
    setLoadedFor(key);
    if (state.id && existing.data) {
      setSupplierId(existing.data.order.supplierId); setExpected(existing.data.order.expectedOn ?? ''); setNote(existing.data.order.note ?? '');
      setLines(existing.data.lines.map((l) => ({ itemId: l.itemId, qty: fmt(l.quantity).replace(/\./g, ''), cost: (Number(l.unitCostCents) / 100).toFixed(2).replace('.', ',') })));
    } else { setSupplierId(''); setExpected(''); setNote(''); setLines([{ itemId: '', qty: '', cost: '' }]); }
    setError(null);
  }
  if (!state && loadedFor !== undefined) setLoadedFor(undefined);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!supplierId) { setError('Escolha o fornecedor.'); return; }
    const parsed = [];
    for (const l of lines) {
      const q = parseQty(l.qty), c = l.cost.trim() ? parseMoney(l.cost) : 0;
      if (!l.itemId || q === null || c === null) { setError('Cada linha precisa de item, quantidade e custo válidos.'); return; }
      parsed.push({ itemId: l.itemId, quantity: q, unitCostCents: c });
    }
    setBusy(true); setError(null);
    try {
      const body = { supplierId, expectedOn: expected || null, note: note || null, lines: parsed };
      if (state?.id) await put(`/api/purchase-orders/${state.id}`, body); else await post('/api/purchase-orders', body);
      toast('Pedido salvo como rascunho.'); onSaved();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const set = (i: number, patchL: Partial<FormLine>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patchL } : l)));
  return (
    <Sheet open={state !== null} title={state?.id ? 'Editar pedido' : 'Novo pedido de compra'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Select label="Fornecedor" value={supplierId} onChange={setSupplierId}>
          <option value="">Escolha…</option>{suppliers.data?.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Field label="Previsão de entrega (opcional)">{(id) => <input id={id} type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />}</Field>
        <h3>Itens</h3>
        {lines.map((l, i) => (
          <div key={i} className="stack card">
            <Select label={`Item ${i + 1}`} value={l.itemId} onChange={(v) => set(i, { itemId: v })}>
              <option value="">Escolha…</option>{items.data?.items.map((it) => <option key={it.id} value={it.id} disabled={lines.some((x, k) => k !== i && x.itemId === it.id)}>{it.name} ({it.unit})</option>)}
            </Select>
            <div className="grid2"><TextInput label="Quantidade" value={l.qty} onChange={(v) => set(i, { qty: v })} inputMode="decimal" /><TextInput label="Custo unitário (R$)" value={l.cost} onChange={(v) => set(i, { cost: v })} inputMode="decimal" /></div>
            {lines.length > 1 && <div><Button variant="ghost" className="btn-sm" onClick={() => setLines(lines.filter((_, k) => k !== i))}>Remover item</Button></div>}
          </div>
        ))}
        <Button variant="secondary" className="btn-block" onClick={() => setLines([...lines, { itemId: '', qty: '', cost: '' }])}>Adicionar item</Button>
        <TextInput label="Observação (opcional)" value={note} onChange={setNote} />
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" busy={busy} className="btn-block">Salvar rascunho</Button>
      </form>
    </Sheet>
  );
}

function OrderView({ id, canWrite, onClose, onChanged, onEdit }: { id: string | null; canWrite: boolean; onClose: () => void; onChanged: () => void; onEdit: (id: string) => void }) {
  const toast = useToast();
  const d = useLoad(() => (id ? get<{ order: Order; lines: Line[] }>(`/api/purchase-orders/${id}`) : Promise.resolve(null)), [id]);
  const [receive, setReceive] = useState<Record<string, { qty: string; lot: string; exp: string }>>({});
  const [cancel, setCancel] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const o = d.data?.order;

  async function act(kind: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(kind); setError(null);
    try { await fn(); toast(ok); setKey(crypto.randomUUID()); setReceive({}); setCancel(false); setReason(''); d.reload(); onChanged(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }
  function submitReceive() {
    const lines: { lineId: string; quantity: number; lotCode?: string; expiresOn?: string }[] = [];
    for (const l of d.data!.lines) {
      const r = receive[l.id];
      if (!r || !r.qty.trim()) continue;
      const q = parseQty(r.qty);
      if (q === null) { setError(`Quantidade inválida em ${l.itemName}.`); return; }
      lines.push({ lineId: l.id, quantity: q, lotCode: r.lot.trim() || undefined, expiresOn: r.exp || undefined });
    }
    if (!lines.length) { setError('Informe a quantidade recebida de ao menos um item.'); return; }
    void act('receive', () => post(`/api/purchase-orders/${id}/receive`, { idempotencyKey: key, lines }), 'Recebimento registrado: o estoque foi atualizado.');
  }

  return (
    <Sheet open={id !== null} title={o ? `Pedido nº ${o.number}` : 'Pedido'} onClose={onClose}>
      {d.loading && !d.data && <Spinner />}
      {d.error && <ErrorBox message={d.error} onRetry={d.reload} />}
      {o && d.data && (
        <>
          <p><Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge> <strong>{o.supplierName}</strong><br />
            <span className="small muted">Total {brl(o.totalCents)} · criado {dateTimeOf(o.createdAt)}{o.createdByName ? ` por ${o.createdByName}` : ''}{o.expectedOn ? ` · previsto ${dmy(o.expectedOn)}` : ''}{o.note ? ` · ${o.note}` : ''}{o.cancelReason ? ` · motivo: ${o.cancelReason}` : ''}</span></p>
          <ul className="list">
            {d.data.lines.map((l) => {
              const remaining = Number(l.quantity) - Number(l.received);
              const canReceive = canWrite && ['sent', 'partial'].includes(o.status) && remaining > 0;
              const r = receive[l.id] ?? { qty: '', lot: '', exp: '' };
              return (
                <li key={l.id} className="list-item stack">
                  <div className="row between"><strong>{l.itemName}</strong><span>{fmt(l.received)} / {fmt(l.quantity)} {l.unit}</span></div>
                  <span className="small muted">{brl(l.unitCostCents)} por {l.unit}{remaining > 0 && o.status !== 'draft' && o.status !== 'canceled' ? ` · falta ${fmt(String(remaining))}` : ''}</span>
                  {canReceive && (
                    <>
                      <div className="grid2"><TextInput label={`Receber agora (${l.unit})`} value={r.qty} onChange={(v) => setReceive({ ...receive, [l.id]: { ...r, qty: v } })} inputMode="decimal" placeholder={fmt(String(remaining))} />
                        <TextInput label="Lote (opcional)" value={r.lot} onChange={(v) => setReceive({ ...receive, [l.id]: { ...r, lot: v } })} /></div>
                      <Field label="Validade (opcional)">{(fid) => <input id={fid} type="date" value={r.exp} onChange={(e) => setReceive({ ...receive, [l.id]: { ...r, exp: e.target.value } })} />}</Field>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {error && <p className="field-msg error" role="alert">{error}</p>}
          {canWrite && o.status === 'draft' && <div className="stack"><Button className="btn-block" busy={busy === 'send'} onClick={() => act('send', () => post(`/api/purchase-orders/${id}/send`), 'Pedido enviado.')}>Marcar como enviado</Button><Button variant="secondary" className="btn-block" onClick={() => onEdit(o.id)}>Editar rascunho</Button></div>}
          {canWrite && ['sent', 'partial'].includes(o.status) && <Button className="btn-block" busy={busy === 'receive'} onClick={submitReceive}>Registrar recebimento</Button>}
          {canWrite && o.status === 'partial' && <Button variant="secondary" className="btn-block" busy={busy === 'close'} onClick={() => { if (window.confirm('Encerrar o pedido sem esperar o restante?')) void act('close', () => post(`/api/purchase-orders/${id}/close`), 'Pedido encerrado.'); }}>Encerrar sem o restante</Button>}
          {canWrite && ['draft', 'sent'].includes(o.status) && !cancel && <Button variant="ghost" className="btn-block" onClick={() => setCancel(true)}>Cancelar pedido</Button>}
          {cancel && (
            <form onSubmit={(e) => { e.preventDefault(); void act('cancel', () => post(`/api/purchase-orders/${id}/cancel`, { reason }), 'Pedido cancelado.'); }} noValidate>
              <TextInput label="Motivo do cancelamento" value={reason} onChange={setReason} />
              <Button type="submit" variant="danger" busy={busy === 'cancel'} className="btn-block">Confirmar cancelamento</Button>
            </form>
          )}
        </>
      )}
    </Sheet>
  );
}
