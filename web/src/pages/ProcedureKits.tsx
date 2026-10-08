import { useState, type FormEvent } from 'react';
import { del, get, post, put } from '../api';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

interface Supply { id: string; procedure: string; itemId: string; itemName: string; unit: string; quantity: string }
interface Shortage { planItemId: string; itemId: string; itemName: string; unit: string; quantity: string; procedure: string; createdAt: string }
interface ItemOpt { id: string; name: string; unit: string; active: boolean }
const fmt = (v: string) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const parseQty = (s: string): number | null => { const t = s.trim().replace(',', '.'); return /^\d+(\.\d{1,3})?$/.test(t) && Number(t) > 0 ? Number(t) : null; };

/** Materiais que cada procedimento consome e as baixas pendentes por falta de saldo. */
export function ProcedureKits({ open, onClose, canWrite, onChanged }: { open: boolean; onClose: () => void; canWrite: boolean; onChanged: () => void }) {
  const toast = useToast();
  const kits = useLoad(() => (open ? get<{ supplies: Supply[] }>('/api/inventory/procedure-supplies') : Promise.resolve({ supplies: [] as Supply[] })), [open]);
  const short = useLoad(() => (open ? get<{ shortages: Shortage[] }>('/api/inventory/shortages') : Promise.resolve({ shortages: [] as Shortage[] })), [open]);
  const items = useLoad(() => (open ? get<{ items: ItemOpt[] }>('/api/inventory/items') : Promise.resolve({ items: [] as ItemOpt[] })), [open]);
  const [f, setF] = useState({ procedure: '', itemId: '', qty: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    const q = parseQty(f.qty);
    if (f.procedure.trim().length < 2) { setError('Informe o nome do procedimento, igual ao usado no plano de tratamento.'); return; }
    if (!f.itemId) { setError('Escolha o material.'); return; }
    if (q === null) { setError('Informe uma quantidade positiva, com até 3 casas.'); return; }
    setBusy('add'); setError(null);
    try { await put('/api/inventory/procedure-supplies', { procedure: f.procedure, itemId: f.itemId, quantity: q }); setF({ ...f, itemId: '', qty: '' }); kits.reload(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }
  async function remove(s: Supply) {
    setBusy(s.id);
    try { await del(`/api/inventory/procedure-supplies/${s.id}`); kits.reload(); } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(null); }
  }
  async function resolve(s: Shortage, action: 'consume' | 'dismiss') {
    let note: string | undefined;
    if (action === 'dismiss') { note = window.prompt('Por que a baixa não será feita? (mín. 3 letras)') ?? undefined; if (!note) return; }
    const k = `${s.planItemId}${s.itemId}${action}`;
    setBusy(k);
    try { await post(`/api/inventory/shortages/${s.planItemId}/${s.itemId}/resolve`, { action, note }); toast(action === 'consume' ? 'Baixa registrada.' : 'Pendência encerrada.'); short.reload(); onChanged(); }
    catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(null); }
  }

  const groups = new Map<string, Supply[]>();
  for (const s of kits.data?.supplies ?? []) groups.set(s.procedure, [...(groups.get(s.procedure) ?? []), s]);

  return (
    <Sheet open={open} title="Materiais por procedimento" onClose={onClose}>
      {short.data && short.data.shortages.length > 0 && (
        <section className="stack" aria-labelledby="short-title">
          <h3 id="short-title">Baixas pendentes por falta de saldo</h3>
          <ul className="list">
            {short.data.shortages.map((s) => (
              <li key={s.planItemId + s.itemId} className="list-item stack">
                <span className="row between"><strong>{s.itemName}</strong><Badge tone="warn">{fmt(s.quantity)} {s.unit}</Badge></span>
                <span className="small muted">Procedimento concluído: {s.procedure}</span>
                {canWrite && <div className="row">
                  <Button className="btn-sm" busy={busy === s.planItemId + s.itemId + 'consume'} onClick={() => resolve(s, 'consume')}>Dar baixa agora</Button>
                  <Button variant="ghost" className="btn-sm" onClick={() => resolve(s, 'dismiss')}>Encerrar sem baixa</Button>
                </div>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {kits.loading && !kits.data && <Spinner />}
      {kits.error && <ErrorBox message={kits.error} onRetry={kits.reload} />}
      {kits.data && groups.size === 0 && <Empty title="Nenhum kit cadastrado">Ao concluir um procedimento do plano, o sistema dá baixa dos materiais cadastrados aqui.</Empty>}
      {[...groups.entries()].map(([proc, rows]) => (
        <section key={proc} className="stack">
          <h3>{proc}</h3>
          <ul className="list">
            {rows.map((s) => (
              <li key={s.id} className="list-item row between">
                <span>{s.itemName} · <strong>{fmt(s.quantity)} {s.unit}</strong></span>
                {canWrite && <Button variant="ghost" className="btn-sm" busy={busy === s.id} onClick={() => remove(s)}>Remover</Button>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {canWrite && (
        <form onSubmit={add} noValidate>
          <h3>Adicionar material ao kit</h3>
          <TextInput label="Procedimento" value={f.procedure} onChange={(v) => setF({ ...f, procedure: v })} hint="Igual ao nome usado no plano de tratamento (maiúsculas não importam)." />
          <Select label="Material" value={f.itemId} onChange={(v) => setF({ ...f, itemId: v })}>
            <option value="">Escolha…</option>
            {items.data?.items.filter((i) => i.active).map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
          </Select>
          <TextInput label="Quantidade por procedimento" value={f.qty} onChange={(v) => setF({ ...f, qty: v })} inputMode="decimal" />
          {error && <p role="alert" className="error">{error}</p>}
          <Button type="submit" busy={busy === 'add'}>Salvar no kit</Button>
        </form>
      )}
      <p className="small muted">Ao concluir o procedimento, a baixa sai pelo lote que vence primeiro. Se faltar saldo, o procedimento é concluído mesmo assim e a baixa fica pendente aqui.</p>
    </Sheet>
  );
}
