import { useEffect, useState, type FormEvent } from 'react';
import { get, patch, post, put } from '../api';
import { brl, dateTimeOf, parseMoney } from '../format';
import { ProcedureKits } from './ProcedureKits';
import { Purchasing } from './Purchasing';
import { Badge, Button, Empty, ErrorBox, Field, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

interface Item { id: string; name: string; sku: string | null; unit: string; minQuantity: string; active: boolean; balance: string; low: boolean; expiredQty?: string; usableBalance?: string; nextExpiry?: string | null; expired?: boolean; expiringSoon?: boolean }
interface Lot { id: string; code: string; expiresOn: string | null; balance: string; daysLeft: number | null; status: 'ok' | 'expiring' | 'expired' }
interface Move { id: string; kind: 'in' | 'out' | 'adjust'; delta: string; unitCostCents: string | null; reason: string | null; createdAt: string; authorName: string | null; lotCode?: string | null; expiresOn?: string | null }
const dmy = (iso: string) => iso.split('-').reverse().join('/');

/** "1,5" | "1.5" | "2" → número; null se inválido (no máximo 3 casas). */
function parseQty(input: string): number | null {
  const s = input.trim().replace(',', '.');
  if (!/^-?\d+(\.\d{1,3})?$/.test(s)) return null;
  return Number(s);
}
const fmt = (v: string) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const KIND: Record<string, string> = { in: 'Entrada', out: 'Saída', adjust: 'Ajuste' };

export function InventoryPage({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const list = useLoad(() => get<{ items: Item[]; lowCount: number; expiredCount: number; expiringCount: number }>(`/api/inventory/items?${new URLSearchParams({ ...(debounced ? { q: debounced } : {}), ...(lowOnly ? { lowOnly: '1' } : {}), includeInactive: '1' })}`), [debounced, lowOnly]);
  const [move, setMove] = useState<{ item: Item; kind: 'in' | 'out' | 'adjust' } | null>(null);
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const [history, setHistory] = useState<Item | null>(null);
  const [lotsOf, setLotsOf] = useState<Item | null>(null);
  const [counting, setCounting] = useState(false);
  const [kits, setKits] = useState(false);
  const [purchasing, setPurchasing] = useState<'suppliers' | 'orders' | null>(null);
  const [f, setF] = useState({ qty: '', cost: '', reason: '', name: '', sku: '', unit: 'un', min: '', lot: '', expires: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());

  const openMove = (item: Item, kind: 'in' | 'out' | 'adjust') => { setF({ ...f, qty: '', cost: '', reason: '', lot: '', expires: '' }); setError(null); setMove({ item, kind }); };
  const openEdit = (item: Item | 'new') => {
    setError(null); setEditing(item);
    setF(item === 'new' ? { ...f, name: '', sku: '', unit: 'un', min: '' } : { ...f, name: item.name, sku: item.sku ?? '', unit: item.unit, min: String(Number(item.minQuantity)).replace('.', ',') });
  };

  async function submitMove(e: FormEvent) {
    e.preventDefault();
    if (!move) return;
    const qty = parseQty(f.qty);
    if (qty === null || qty === 0 || (move.kind !== 'adjust' && qty < 0)) { setError(move.kind === 'adjust' ? 'Informe a quantidade (use − para reduzir), com até 3 casas.' : 'Informe uma quantidade positiva, com até 3 casas.'); return; }
    if (f.expires && !f.lot.trim()) { setError('Informe o código do lote junto com a validade.'); return; }
    const cost = f.cost.trim() ? parseMoney(f.cost) : undefined;
    if (cost === null) { setError('Custo inválido. Use o formato 25,00.'); return; }
    setBusy(true); setError(null);
    try {
      await post('/api/inventory/movements', { itemId: move.item.id, kind: move.kind, quantity: qty, unitCostCents: move.kind === 'in' ? cost : undefined, reason: f.reason || undefined, idempotencyKey: key,
        ...(move.kind === 'in' && f.lot.trim() ? { lotCode: f.lot.trim(), expiresOn: f.expires || undefined } : {}) });
      toast(`${KIND[move.kind]} registrada.`); setMove(null); setKey(crypto.randomUUID()); list.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function submitItem(e: FormEvent) {
    e.preventDefault();
    const min = f.min.trim() ? parseQty(f.min) : 0;
    if (f.name.trim().length < 2) { setError('Informe o nome do item.'); return; }
    if (min === null || min < 0) { setError('Estoque mínimo inválido.'); return; }
    setBusy(true); setError(null);
    try {
      if (editing === 'new') await post('/api/inventory/items', { name: f.name, sku: f.sku || undefined, unit: f.unit || 'un', minQuantity: min });
      else if (editing) await patch(`/api/inventory/items/${editing.id}`, { name: f.name, minQuantity: min });
      toast('Item salvo.'); setEditing(null); list.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function toggleActive(item: Item) {
    try { await patch(`/api/inventory/items/${item.id}`, { active: !item.active }); toast(item.active ? 'Item inativado.' : 'Item reativado.'); list.reload(); }
    catch (err) { toast((err as Error).message, 'bad'); }
  }

  return (
    <>
      <div className="page-head"><h1>Estoque</h1><span className="row"><Button variant="secondary" onClick={() => setKits(true)}>Kits</Button><Button variant="secondary" onClick={() => setPurchasing('orders')}>Pedidos</Button><Button variant="secondary" onClick={() => setPurchasing('suppliers')}>Fornecedores</Button>{canWrite && <Button variant="secondary" onClick={() => setCounting(true)}>Inventário</Button>}{canWrite && <Button onClick={() => openEdit('new')}>Novo item</Button>}</span></div>
      {list.data && list.data.lowCount > 0 && <div className="banner" role="note">⚠ {list.data.lowCount} {list.data.lowCount === 1 ? 'item está' : 'itens estão'} no estoque mínimo ou abaixo.</div>}
      {list.data && (list.data.expiredCount > 0 || list.data.expiringCount > 0) && (
        <div className="banner" role="note">
          {list.data.expiredCount > 0 && <>⛔ {list.data.expiredCount} {list.data.expiredCount === 1 ? 'item tem' : 'itens têm'} lote vencido. </>}
          {list.data.expiringCount > 0 && <>⏳ {list.data.expiringCount} {list.data.expiringCount === 1 ? 'item vence' : 'itens vencem'} em até 30 dias.</>}
        </div>
      )}
      <div className="card">
        <Field label="Buscar item" hint="Nome ou código (SKU).">{(id, d) => <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-describedby={d} autoComplete="off" />}</Field>
        <label className="row"><input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Só itens no mínimo ou abaixo</label>
      </div>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && list.data.items.length === 0 && <Empty title={lowOnly ? 'Nenhum item abaixo do mínimo' : 'Nenhum item cadastrado'}>{canWrite && !lowOnly && <Button onClick={() => openEdit('new')}>Cadastrar o primeiro item</Button>}</Empty>}
      <ul className="list">
        {list.data?.items.map((i) => (
          <li key={i.id} className="list-item stack">
            <div className="row between">
              <strong>{i.name}</strong>
              <span className="row">{!i.active && <Badge>Inativo</Badge>}{i.expired && <Badge tone="bad">Vencido</Badge>}{i.expiringSoon && !i.expired && <Badge tone="warn">Vence {dmy(i.nextExpiry!)}</Badge>}{i.low && i.active && <Badge tone="bad">Baixo</Badge>}<strong>{fmt(i.balance)} {i.unit}</strong></span>
            </div>
            <span className="small muted">{i.sku ? `Código ${i.sku} · ` : ''}mínimo {fmt(i.minQuantity)} {i.unit}</span>
            <div className="row">
              {canWrite && i.active && <><Button className="btn-sm" onClick={() => openMove(i, 'in')}>Entrada</Button>
                <Button variant="secondary" className="btn-sm" onClick={() => openMove(i, 'out')}>Saída</Button>
                <Button variant="secondary" className="btn-sm" onClick={() => openMove(i, 'adjust')}>Ajustar</Button></>}
              <Button variant="ghost" className="btn-sm" onClick={() => setLotsOf(i)}>Lotes</Button>
              <Button variant="ghost" className="btn-sm" onClick={() => setHistory(i)}>Histórico</Button>
              {canWrite && <><Button variant="ghost" className="btn-sm" onClick={() => openEdit(i)}>Editar</Button>
                <Button variant="ghost" className="btn-sm" onClick={() => toggleActive(i)}>{i.active ? 'Inativar' : 'Reativar'}</Button></>}
            </div>
          </li>
        ))}
      </ul>

      <Sheet open={move !== null} title={move ? `${KIND[move.kind]}: ${move.item.name}` : ''} onClose={() => setMove(null)}>
        {move && (
          <form onSubmit={submitMove} noValidate>
            <p className="small muted">Saldo atual: {fmt(move.item.balance)} {move.item.unit}</p>
            <TextInput label={`Quantidade (${move.item.unit})`} value={f.qty} onChange={(v) => setF({ ...f, qty: v })} inputMode="decimal" hint={move.kind === 'adjust' ? 'Use − para reduzir o saldo (ex.: -2).' : undefined} />
            {move.kind === 'in' && <TextInput label="Custo unitário (R$, opcional)" value={f.cost} onChange={(v) => setF({ ...f, cost: v })} inputMode="decimal" />}
            {move.kind === 'in' && (
              <div className="grid2">
                <TextInput label="Lote (opcional)" value={f.lot} onChange={(v) => setF({ ...f, lot: v })} />
                <Field label="Validade (opcional)">{(id) => <input id={id} type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} />}</Field>
              </div>
            )}
            {move.kind === 'out' && <p className="small muted">A saída usa primeiro o lote que vence antes. Lote vencido não sai.</p>}
            <TextInput label={move.kind === 'adjust' ? 'Motivo do ajuste (obrigatório)' : 'Observação (opcional)'} value={f.reason} onChange={(v) => setF({ ...f, reason: v })} />
            {error && <p className="field-msg error" role="alert">{error}</p>}
            <Button type="submit" busy={busy} className="btn-block">Registrar {(KIND[move.kind] ?? '').toLowerCase()}</Button>
          </form>
        )}
      </Sheet>

      <Sheet open={editing !== null} title={editing === 'new' ? 'Novo item' : 'Editar item'} onClose={() => setEditing(null)}>
        <form onSubmit={submitItem} noValidate>
          <TextInput label="Nome" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
          {editing === 'new' && <div className="grid2"><TextInput label="Código (opcional)" value={f.sku} onChange={(v) => setF({ ...f, sku: v })} /><TextInput label="Unidade" value={f.unit} onChange={(v) => setF({ ...f, unit: v })} hint="un, cx, ml…" /></div>}
          <TextInput label="Estoque mínimo" value={f.min} onChange={(v) => setF({ ...f, min: v })} inputMode="decimal" hint="Abaixo ou igual a este valor o item aparece como baixo." />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Salvar item</Button>
        </form>
      </Sheet>

      <Purchasing open={purchasing} onClose={() => setPurchasing(null)} canWrite={canWrite} onChanged={list.reload} />
      <ProcedureKits open={kits} onClose={() => setKits(false)} canWrite={canWrite} onChanged={list.reload} />
      <StockCount open={counting} onClose={() => setCounting(false)} onChanged={list.reload} />
      <Lots item={lotsOf} canWrite={canWrite} onClose={() => setLotsOf(null)} onChanged={list.reload} />
      <History item={history} onClose={() => setHistory(null)} />
    </>
  );
}

function History({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const h = useLoad(() => (item ? get<{ movements: Move[] }>(`/api/inventory/items/${item.id}/movements`) : Promise.resolve({ movements: [] as Move[] })), [item?.id]);
  return (
    <Sheet open={item !== null} title={item ? `Histórico: ${item.name}` : ''} onClose={onClose}>
      {h.loading && <Spinner />}
      {h.error && <ErrorBox message={h.error} onRetry={h.reload} />}
      {h.data?.movements.length === 0 && <Empty title="Sem movimentos" />}
      <ul className="list">
        {h.data?.movements.map((m) => (
          <li key={m.id} className="list-item row between">
            <div><strong>{KIND[m.kind]}</strong>{m.lotCode ? ` · lote ${m.lotCode}${m.expiresOn ? ` (vence ${dmy(m.expiresOn)})` : ''}` : ''}{m.unitCostCents ? ` · ${brl(m.unitCostCents)}/${item?.unit}` : ''}<br /><span className="small muted">{dateTimeOf(m.createdAt)} · {m.authorName ?? '—'}{m.reason ? ` · ${m.reason}` : ''}</span></div>
            <strong>{Number(m.delta) > 0 ? '+' : ''}{fmt(m.delta)}</strong>
          </li>
        ))}
      </ul>
      <p className="small muted">O histórico não pode ser alterado: erros se corrigem com um ajuste explicado.</p>
    </Sheet>
  );
}

function Lots({ item, canWrite, onClose, onChanged }: { item: Item | null; canWrite: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const d = useLoad(() => (item ? get<{ lots: Lot[] }>(`/api/inventory/items/${item.id}/lots`) : Promise.resolve({ lots: [] as Lot[] })), [item?.id]);
  const [busy, setBusy] = useState<string | null>(null);

  async function discard(l: Lot) {
    if (!item) return;
    setBusy(l.id);
    try {
      await post('/api/inventory/movements', { itemId: item.id, kind: 'adjust', quantity: -Number(l.balance), lotId: l.id, reason: 'Descarte por vencimento', idempotencyKey: crypto.randomUUID() });
      toast('Lote baixado por vencimento.'); d.reload(); onChanged();
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(null); }
  }

  return (
    <Sheet open={item !== null} title={item ? `Lotes: ${item.name}` : ''} onClose={onClose}>
      {d.loading && <Spinner />}
      {d.error && <ErrorBox message={d.error} onRetry={d.reload} />}
      {d.data?.lots.length === 0 && <Empty title="Nenhum lote cadastrado">Informe o lote e a validade ao registrar uma entrada.</Empty>}
      <ul className="list">
        {d.data?.lots.map((l) => (
          <li key={l.id} className="list-item stack">
            <div className="row between">
              <strong>Lote {l.code}</strong>
              <span className="row">
                {l.status === 'expired' && Number(l.balance) > 0 && <Badge tone="bad">Vencido</Badge>}
                {l.status === 'expiring' && Number(l.balance) > 0 && <Badge tone="warn">Vence em {l.daysLeft} {l.daysLeft === 1 ? 'dia' : 'dias'}</Badge>}
                <strong>{fmt(l.balance)} {item?.unit}</strong>
              </span>
            </div>
            <span className="small muted">{l.expiresOn ? `Validade ${dmy(l.expiresOn)}` : 'Sem validade informada'}</span>
            {canWrite && l.status === 'expired' && Number(l.balance) > 0 && <div><Button variant="secondary" className="btn-sm" busy={busy === l.id} onClick={() => discard(l)}>Dar baixa por vencimento</Button></div>}
          </li>
        ))}
      </ul>
      <p className="small muted">Saídas usam primeiro o lote que vence antes. O que está vencido não conta como saldo utilizável.</p>
    </Sheet>
  );
}

interface CountSummary { id: string; title: string; status: 'open' | 'closed' | 'canceled'; lineCount: number; countedCount: number; createdAt: string; finishedAt: string | null }
interface CountLine { itemId: string; name: string; unit: string; counted: string | null; balanceAtCount: string | null; currentBalance: string; diff: string | null }

function StockCount({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const list = useLoad(() => (open ? get<{ counts: CountSummary[] }>('/api/inventory/counts') : Promise.resolve({ counts: [] as CountSummary[] })), [open]);
  const current = list.data?.counts.find((c) => c.status === 'open') ?? null;
  const detail = useLoad(() => (current ? get<{ lines: CountLine[] }>(`/api/inventory/counts/${current.id}`) : Promise.resolve({ lines: [] as CountLine[] })), [current?.id, open]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => { list.reload(); detail.reload(); onChanged(); };

  async function start() {
    setBusy('start'); setError(null);
    try { await post('/api/inventory/counts', { title: title.trim() || undefined }); setTitle(''); toast('Inventário iniciado.'); reload(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }
  async function saveLine(l: CountLine) {
    const raw = (vals[l.itemId] ?? '').trim().replace(',', '.');
    if (!/^\d+(\.\d{1,3})?$/.test(raw)) { setError('Informe a quantidade contada (número, até 3 casas).'); return; }
    setBusy(l.itemId); setError(null);
    try { await put(`/api/inventory/counts/${current!.id}/lines/${l.itemId}`, { counted: Number(raw) }); setVals((v) => { const n = { ...v }; delete n[l.itemId]; return n; }); detail.reload(); list.reload(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }
  async function finish(kind: 'close' | 'cancel') {
    if (kind === 'cancel' && !window.confirm('Cancelar o inventário? Nenhum saldo será alterado.')) return;
    setBusy(kind); setError(null);
    try {
      const r = await post<{ adjusted?: number; unchanged?: number; notCounted?: number }>(`/api/inventory/counts/${current!.id}/${kind}`, {});
      toast(kind === 'close' ? `Inventário concluído: ${r.adjusted} ajuste(s), ${r.unchanged} sem diferença${r.notCounted ? `, ${r.notCounted} não contado(s)` : ''}.` : 'Inventário cancelado.');
      reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  const done = list.data?.counts.filter((c) => c.status !== 'open').slice(0, 5) ?? [];
  return (
    <Sheet open={open} title="Inventário de estoque" onClose={onClose}>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && !current && (
        <>
          <p className="small muted">Conte o estoque físico e deixe o sistema ajustar as diferenças com o motivo registrado. Os movimentos feitos durante a contagem são preservados.</p>
          <TextInput label="Nome do inventário (opcional)" value={title} onChange={setTitle} />
          <Button busy={busy === 'start'} className="btn-block" onClick={start}>Iniciar inventário</Button>
          {done.length > 0 && (
            <>
              <h3>Anteriores</h3>
              <ul className="list">{done.map((c) => <li key={c.id} className="list-item row between"><span><strong>{c.title}</strong><br /><span className="small muted">{c.finishedAt ? dateTimeOf(c.finishedAt) : ''} · {c.countedCount}/{c.lineCount} contados</span></span><Badge tone={c.status === 'closed' ? 'ok' : 'neutral'}>{c.status === 'closed' ? 'Concluído' : 'Cancelado'}</Badge></li>)}</ul>
            </>
          )}
        </>
      )}
      {current && (
        <>
          <p><strong>{current.title}</strong><br /><span className="small muted">{current.countedCount} de {current.lineCount} itens contados</span></p>
          <ul className="list">
            {detail.data?.lines.map((l) => (
              <li key={l.itemId} className="list-item stack">
                <div className="row between"><strong>{l.name}</strong>{l.counted !== null && <Badge tone={Number(l.diff) === 0 ? 'ok' : 'warn'}>{Number(l.diff) === 0 ? 'Confere' : `${Number(l.diff) > 0 ? '+' : ''}${fmt(l.diff!)} ${l.unit}`}</Badge>}</div>
                <span className="small muted">Saldo no sistema: {fmt(l.currentBalance)} {l.unit}{l.counted !== null ? ` · contado ${fmt(l.counted)}` : ''}</span>
                <div className="row">
                  <div className="grow"><TextInput label={`Contado (${l.unit})`} value={vals[l.itemId] ?? ''} onChange={(v) => setVals({ ...vals, [l.itemId]: v })} inputMode="decimal" /></div>
                  <Button variant="secondary" className="btn-sm" busy={busy === l.itemId} onClick={() => saveLine(l)}>{l.counted !== null ? 'Recontar' : 'Registrar'}</Button>
                </div>
              </li>
            ))}
          </ul>
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button busy={busy === 'close'} disabled={current.countedCount === 0} className="btn-block" onClick={() => finish('close')}>Concluir e ajustar o estoque</Button>
          <Button variant="ghost" busy={busy === 'cancel'} className="btn-block" onClick={() => finish('cancel')}>Cancelar inventário</Button>
        </>
      )}
      {!current && error && <p className="field-msg error" role="alert">{error}</p>}
    </Sheet>
  );
}
