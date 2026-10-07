import { useState, type FormEvent } from 'react';
import { get, patch, post } from '../api';
import { brl, dateTimeOf, parseMoney } from '../format';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

interface QItem { id?: string; tooth: string | null; procedure: string; priceCents: string }
interface Quote {
  id: string; groupId: string; version: number; status: 'draft' | 'presented' | 'accepted' | 'rejected' | 'superseded';
  notes: string | null; validUntil: string | null; createdAt: string; presentedAt: string | null; decidedAt: string | null;
  acceptedByName: string | null; acceptedByRole: string | null; decisionNote: string | null; decidedByName: string | null; totalCents: string; items: QItem[];
}
interface Row { procedure: string; tooth: string; price: string }

const STATUS: Record<Quote['status'], { label: string; tone: 'neutral' | 'info' | 'ok' | 'bad' | 'warn' }> = {
  draft: { label: 'Rascunho', tone: 'neutral' }, presented: { label: 'Apresentado', tone: 'info' }, accepted: { label: 'Aceito', tone: 'ok' },
  rejected: { label: 'Recusado', tone: 'bad' }, superseded: { label: 'Substituído', tone: 'warn' },
};
const ymdBr = (ymd: string) => ymd.split('-').reverse().join('/');
const emptyRow = (): Row => ({ procedure: '', tooth: '', price: '' });
const toRows = (items: QItem[]): Row[] => items.map((i) => ({ procedure: i.procedure, tooth: i.tooth ?? '', price: (Number(i.priceCents) / 100).toFixed(2).replace('.', ',') }));

/** Orçamento odontológico com versões. O aceite é registrado pela clínica (não é assinatura eletrônica). */
export function Quotes({ patientId, canWrite, teeth, onAccepted }: { patientId: string; canWrite: boolean; teeth: string[]; onAccepted: () => void }) {
  const toast = useToast();
  const list = useLoad(() => get<{ quotes: Quote[] }>(`/api/patients/${patientId}/dental-quotes`), [patientId]);
  const [editor, setEditor] = useState<{ id: string | null; rows: Row[]; notes: string; validUntil: string } | null>(null);
  const [accepting, setAccepting] = useState<Quote | null>(null);
  const [rejecting, setRejecting] = useState<Quote | null>(null);
  const [f, setF] = useState({ name: '', role: 'patient', note: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Agrupa as versões de cada orçamento (a mais nova primeiro).
  const groups = new Map<string, Quote[]>();
  for (const q of list.data?.quotes ?? []) groups.set(q.groupId, [...(groups.get(q.groupId) ?? []), q]);
  const ordered = [...groups.values()].map((v) => v.sort((a, b) => b.version - a.version));

  async function run(fn: () => Promise<unknown>, okMsg: string, after?: () => void) {
    setBusy(true); setError(null);
    try { await fn(); toast(okMsg); after?.(); list.reload(); } catch (err) { setError((err as Error).message); toast((err as Error).message, 'bad'); } finally { setBusy(false); }
  }

  function parseRows(rows: Row[]) {
    const out = [];
    for (const r of rows) {
      if (!r.procedure.trim() && !r.price.trim()) continue;
      const cents = r.price.trim() ? parseMoney(r.price) : 0;
      if (r.procedure.trim().length < 2) return 'Informe o nome de cada procedimento.';
      if (cents === null) return `Valor inválido em "${r.procedure}". Use o formato 250,00.`;
      out.push({ procedure: r.procedure.trim(), tooth: r.tooth || undefined, priceCents: cents });
    }
    return out.length ? out : 'Inclua ao menos um procedimento.';
  }

  async function saveEditor(e: FormEvent) {
    e.preventDefault();
    if (!editor) return;
    const items = parseRows(editor.rows);
    if (typeof items === 'string') { setError(items); return; }
    await run(async () => {
      if (editor.id) await patch(`/api/dental-quotes/${editor.id}`, { items, notes: editor.notes || null, validUntil: editor.validUntil || null });
      else await post(`/api/patients/${patientId}/dental-quotes`, { items, notes: editor.notes || undefined, validUntil: editor.validUntil || undefined });
    }, editor.id ? 'Rascunho salvo.' : 'Rascunho criado.', () => setEditor(null));
  }

  const editorTotal = editor ? editor.rows.reduce((a, r) => a + (parseMoney(r.price || '0') ?? 0), 0) : 0;
  const open = (q: Quote | null) => { setError(null); setEditor(q ? { id: q.id, rows: toRows(q.items), notes: q.notes ?? '', validUntil: q.validUntil ?? '' } : { id: null, rows: [emptyRow()], notes: '', validUntil: '' }); };

  return (
    <section className="card" aria-labelledby="quotes-title">
      <div className="row between">
        <h2 id="quotes-title">Orçamentos</h2>
        {canWrite && <Button className="btn-sm" onClick={() => open(null)}>Novo orçamento</Button>}
      </div>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && ordered.length === 0 && <Empty title="Nenhum orçamento">Monte um orçamento com os procedimentos e valores para apresentar ao paciente.</Empty>}
      <ul className="list">
        {ordered.map((versions) => {
          const q = versions[0]!;
          const older = versions.slice(1);
          return (
            <li key={q.groupId} className="list-item stack">
              <div className="row between">
                <strong>Orçamento · versão {q.version}</strong>
                <Badge tone={STATUS[q.status].tone}>{STATUS[q.status].label}</Badge>
              </div>
              <ul className="list">
                {q.items.map((i, n) => <li key={i.id ?? n} className="row between small"><span>{i.procedure}{i.tooth ? ` · dente ${i.tooth}` : ''}</span><span>{brl(i.priceCents)}</span></li>)}
              </ul>
              <div className="row between"><strong>Total</strong><strong>{brl(q.totalCents)}</strong></div>
              {q.validUntil && <span className="small muted">Válido até {ymdBr(q.validUntil)}</span>}
              {q.notes && <span className="small muted">{q.notes}</span>}
              {q.status === 'accepted' && (
                <span className="small">Aceito por <strong>{q.acceptedByName}</strong> ({q.acceptedByRole === 'guardian' ? 'responsável legal' : 'paciente'}) em {q.decidedAt ? dateTimeOf(q.decidedAt) : ''}, registrado por {q.decidedByName ?? '—'}. Os procedimentos foram para o plano de tratamento.</span>
              )}
              {q.status === 'rejected' && <span className="small">Recusado: {q.decisionNote}</span>}
              {q.status === 'presented' && <span className="small muted">O aceite é registrado pela clínica e não substitui assinatura eletrônica.</span>}
              {canWrite && (
                <div className="row">
                  {q.status === 'draft' && <><Button variant="secondary" className="btn-sm" onClick={() => open(q)}>Editar</Button>
                    <Button className="btn-sm" busy={busy} onClick={() => run(() => post(`/api/dental-quotes/${q.id}/present`), 'Orçamento apresentado.')}>Apresentar</Button></>}
                  {q.status === 'presented' && <>
                    <Button className="btn-sm" onClick={() => { setF({ name: '', role: 'patient', note: '', reason: '' }); setError(null); setAccepting(q); }}>Registrar aceite</Button>
                    <Button variant="secondary" className="btn-sm" onClick={() => { setF({ name: '', role: 'patient', note: '', reason: '' }); setError(null); setRejecting(q); }}>Registrar recusa</Button></>}
                  {(q.status === 'presented' || q.status === 'rejected' || q.status === 'superseded') && (
                    <Button variant="secondary" className="btn-sm" busy={busy} onClick={() => run(() => post(`/api/dental-quotes/${q.id}/revise`), 'Nova versão criada como rascunho.')}>Nova versão</Button>)}
                </div>
              )}
              {older.length > 0 && (
                <details>
                  <summary className="small">Versões anteriores ({older.length})</summary>
                  <ul className="list">
                    {older.map((o) => (
                      <li key={o.id} className="row between small"><span>Versão {o.version} · {o.presentedAt ? dateTimeOf(o.presentedAt) : 'rascunho'}</span><span>{brl(o.totalCents)} <Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge></span></li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>

      <Sheet open={editor !== null} title={editor?.id ? 'Editar rascunho' : 'Novo orçamento'} onClose={() => setEditor(null)}>
        {editor && (
          <form onSubmit={saveEditor} noValidate>
            {editor.rows.map((r, n) => (
              <fieldset key={n} className="stack">
                <legend className="small muted">Procedimento {n + 1}</legend>
                <TextInput label="Procedimento" value={r.procedure} onChange={(v) => setEditor({ ...editor, rows: editor.rows.map((x, i) => (i === n ? { ...x, procedure: v } : x)) })} />
                <div className="grid2">
                  <Select label="Dente" value={r.tooth} onChange={(v) => setEditor({ ...editor, rows: editor.rows.map((x, i) => (i === n ? { ...x, tooth: v } : x)) })}>
                    <option value="">Geral</option>{teeth.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                  <TextInput label="Valor (R$)" value={r.price} inputMode="decimal" placeholder="250,00" onChange={(v) => setEditor({ ...editor, rows: editor.rows.map((x, i) => (i === n ? { ...x, price: v } : x)) })} />
                </div>
                {editor.rows.length > 1 && <Button type="button" variant="ghost" className="btn-sm" onClick={() => setEditor({ ...editor, rows: editor.rows.filter((_, i) => i !== n) })}>Remover procedimento {n + 1}</Button>}
              </fieldset>
            ))}
            <Button type="button" variant="secondary" className="btn-sm" onClick={() => setEditor({ ...editor, rows: [...editor.rows, emptyRow()] })}>Adicionar procedimento</Button>
            <p><strong>Total: {brl(editorTotal)}</strong></p>
            <TextInput label="Válido até (opcional, padrão 30 dias)" type="date" value={editor.validUntil} onChange={(v) => setEditor({ ...editor, validUntil: v })} />
            <TextInput label="Observações (opcional)" value={editor.notes} onChange={(v) => setEditor({ ...editor, notes: v })} />
            {error && <p className="field-msg error" role="alert">{error}</p>}
            <Button type="submit" busy={busy} className="btn-block">Salvar rascunho</Button>
          </form>
        )}
      </Sheet>

      <Sheet open={accepting !== null} title="Registrar aceite" onClose={() => setAccepting(null)}>
        <form noValidate onSubmit={(e) => { e.preventDefault(); if (accepting) void run(() => post(`/api/dental-quotes/${accepting.id}/accept`, { acceptedByName: f.name, acceptedByRole: f.role, note: f.note || undefined }), 'Aceite registrado. Procedimentos adicionados ao plano.', () => { setAccepting(null); onAccepted(); }); }}>
          {accepting && <p className="small muted">Total {brl(accepting.totalCents)}. Os procedimentos entram no plano de tratamento. O aceite é registrado pela clínica e não substitui assinatura eletrônica.</p>}
          <TextInput label="Nome de quem aceitou" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
          <Select label="Aceitou como" value={f.role} onChange={(v) => setF({ ...f, role: v })}><option value="patient">Paciente</option><option value="guardian">Responsável legal</option></Select>
          <TextInput label="Observação (opcional)" value={f.note} onChange={(v) => setF({ ...f, note: v })} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Registrar aceite</Button>
        </form>
      </Sheet>

      <Sheet open={rejecting !== null} title="Registrar recusa" onClose={() => setRejecting(null)}>
        <form noValidate onSubmit={(e) => { e.preventDefault(); if (rejecting) void run(() => post(`/api/dental-quotes/${rejecting.id}/reject`, { reason: f.reason }), 'Recusa registrada.', () => setRejecting(null)); }}>
          <TextInput label="Motivo da recusa" value={f.reason} onChange={(v) => setF({ ...f, reason: v })} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" variant="danger" busy={busy} className="btn-block">Registrar recusa</Button>
        </form>
      </Sheet>
    </section>
  );
}
