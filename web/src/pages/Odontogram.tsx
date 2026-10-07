import { useMemo, useState, type FormEvent } from 'react';
import { get, patch, post } from '../api';
import { brl, dateTimeOf, parseMoney } from '../format';
import { Quotes } from './Quotes';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

interface Finding { tooth: string; surface: string | null; condition: string; note: string | null; createdAt: string }
interface HistoryEvent { id: string; surface: string | null; condition: string; note: string | null; createdAt: string; authorName: string }
interface PlanItem { id: string; tooth: string | null; procedure: string; priceCents: string; priority: number; status: string; completedAt: string | null }

const COND: Record<string, { label: string; abbr: string }> = {
  healthy: { label: 'Hígido', abbr: 'H' }, caries: { label: 'Cárie', abbr: 'C' }, restoration: { label: 'Restauração', abbr: 'R' },
  sealant: { label: 'Selante', abbr: 'S' }, fracture: { label: 'Fratura', abbr: 'F' }, missing: { label: 'Ausente', abbr: 'A' },
  crown: { label: 'Coroa', abbr: 'Co' }, endodontic: { label: 'Endodontia', abbr: 'E' }, implant: { label: 'Implante', abbr: 'I' },
  extraction_planned: { label: 'Extração indicada', abbr: 'X' },
};
const SURFACE_CONDS = ['healthy', 'caries', 'restoration', 'sealant', 'fracture'];
const TOOTH_CONDS = ['healthy', 'missing', 'crown', 'endodontic', 'implant', 'extraction_planned', ...SURFACE_CONDS.filter((c) => c !== 'healthy')];
const SURFACES: Record<string, string> = { M: 'Mesial', D: 'Distal', O: 'Oclusal', V: 'Vestibular', L: 'Lingual' };
const range = (from: number, to: number) => Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => String(from + (to > from ? i : -i)));

const LAYOUT = {
  permanent: { cols: 'n8', quads: [
    { label: 'Superior direito', teeth: range(18, 11) }, { label: 'Superior esquerdo', teeth: range(21, 28) },
    { label: 'Inferior direito', teeth: range(48, 41) }, { label: 'Inferior esquerdo', teeth: range(31, 38) }] },
  deciduous: { cols: 'n5', quads: [
    { label: 'Superior direito', teeth: range(55, 51) }, { label: 'Superior esquerdo', teeth: range(61, 65) },
    { label: 'Inferior direito', teeth: range(85, 81) }, { label: 'Inferior esquerdo', teeth: range(71, 75) }] },
} as const;

export function Odontogram({ patientId, canWrite, hasFinance }: { patientId: string; canWrite: boolean; hasFinance: boolean }) {
  const [dentition, setDentition] = useState<'permanent' | 'deciduous'>('permanent');
  const [tooth, setTooth] = useState<string | null>(null);
  const [planKey, setPlanKey] = useState(0); // recarrega o plano quando um orçamento aceito o alimenta
  const data = useLoad(() => get<{ findings: Finding[] }>(`/api/patients/${patientId}/odontogram`), [patientId]);

  const byTooth = useMemo(() => {
    const m = new Map<string, { whole?: Finding; surfaces: Finding[] }>();
    for (const f of data.data?.findings ?? []) {
      const e = m.get(f.tooth) ?? { surfaces: [] };
      if (f.surface === null) e.whole = f; else e.surfaces.push(f);
      m.set(f.tooth, e);
    }
    return m;
  }, [data.data]);

  const layout = LAYOUT[dentition];
  return (
    <div className="stack">
      <div className="switch" role="group" aria-label="Dentição">
        <button type="button" aria-pressed={dentition === 'permanent'} onClick={() => setDentition('permanent')}>Permanente</button>
        <button type="button" aria-pressed={dentition === 'deciduous'} onClick={() => setDentition('deciduous')}>Decídua</button>
      </div>
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.data && (
        <div className="arch">
          {layout.quads.map((q) => (
            <section key={q.label} aria-label={q.label}>
              <p className="small muted quad-label">{q.label}</p>
              <div className={`teeth ${layout.cols}`}>
                {q.teeth.map((t) => {
                  const e = byTooth.get(t);
                  const whole = e?.whole && e.whole.condition !== 'healthy' ? e.whole : undefined;
                  const altered = (e?.surfaces ?? []).filter((s) => s.condition !== 'healthy');
                  const cls = whole ? `cond-${whole.condition}` : altered.length ? `cond-${altered[0]!.condition}` : '';
                  const desc = [whole && COND[whole.condition]!.label, ...altered.map((s) => `${COND[s.condition]!.label} (${s.surface})`)].filter(Boolean).join(', ');
                  return (
                    <button key={t} type="button" className={`tooth ${cls}`} onClick={() => setTooth(t)} aria-label={`Dente ${t}${desc ? `: ${desc}` : ': sem achados'}`}>
                      <b>{t}</b>
                      <span aria-hidden="true">{whole ? COND[whole.condition]!.abbr : altered.length ? altered.map((s) => s.surface).join('') : '·'}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
      <details className="card">
        <summary>Legenda</summary>
        <ul className="legend">{Object.entries(COND).map(([k, v]) => <li key={k}><span className={`tooth-chip cond-${k}`}>{v.abbr}</span> {v.label}</li>)}</ul>
        <p className="small muted">Letras M, D, O, V, L indicam as faces com achado (mesial, distal, oclusal, vestibular, lingual).</p>
      </details>
      <ToothSheet patientId={patientId} tooth={tooth} canWrite={canWrite} onClose={() => setTooth(null)} onSaved={data.reload} />
      <TreatmentPlan patientId={patientId} canWrite={canWrite} hasFinance={hasFinance} teeth={layout.quads.flatMap((q) => [...q.teeth])} reloadKey={planKey} />
      <Quotes patientId={patientId} canWrite={canWrite} teeth={layout.quads.flatMap((q) => [...q.teeth])} onAccepted={() => setPlanKey((k) => k + 1)} />
    </div>
  );
}

function ToothSheet({ patientId, tooth, canWrite, onClose, onSaved }: { patientId: string; tooth: string | null; canWrite: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [surface, setSurface] = useState('');
  const [condition, setCondition] = useState('caries');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hist = useLoad(() => (tooth ? get<{ events: HistoryEvent[] }>(`/api/patients/${patientId}/odontogram/history?tooth=${tooth}`) : Promise.resolve({ events: [] })), [tooth, patientId]);
  const options = surface ? SURFACE_CONDS : TOOTH_CONDS;

  function changeSurface(v: string) { setSurface(v); if (v && !SURFACE_CONDS.includes(condition)) setCondition('caries'); }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await post(`/api/patients/${patientId}/odontogram/findings`, { tooth, surface: surface || null, condition, note: note || null });
      toast(`Dente ${tooth}: achado registrado.`); setNote(''); onSaved(); hist.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <Sheet open={!!tooth} title={`Dente ${tooth ?? ''}`} onClose={onClose}>
      {canWrite && (
        <form onSubmit={submit} noValidate>
          <Select label="Onde" value={surface} onChange={changeSurface}>
            <option value="">Dente inteiro</option>
            {Object.entries(SURFACES).map(([k, v]) => <option key={k} value={k}>{v} ({k})</option>)}
          </Select>
          <Select label="Condição" value={condition} onChange={setCondition}>{options.map((c) => <option key={c} value={c}>{COND[c]!.label}</option>)}</Select>
          <TextInput label="Observação (opcional)" value={note} onChange={setNote} maxLength={500} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Registrar achado</Button>
        </form>
      )}
      <h3>Histórico do dente</h3>
      {hist.loading && <Spinner />}
      {hist.data?.events.length === 0 && <Empty title="Sem achados registrados neste dente" />}
      <ul className="list">
        {hist.data?.events.map((e) => (
          <li key={e.id} className="list-item">
            <strong>{COND[e.condition]?.label}</strong>{e.surface ? ` · face ${SURFACES[e.surface]}` : ' · dente inteiro'}
            <br /><span className="small muted">{e.authorName} · {dateTimeOf(e.createdAt)}{e.note ? ` · ${e.note}` : ''}</span>
          </li>
        ))}
      </ul>
      <p className="small muted">Os registros são mantidos como histórico: um novo achado não apaga o anterior.</p>
    </Sheet>
  );
}

const STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'ok' | 'bad' }> = {
  planned: { label: 'Planejado', tone: 'neutral' }, in_progress: { label: 'Em andamento', tone: 'info' }, done: { label: 'Concluído', tone: 'ok' }, cancelled: { label: 'Cancelado', tone: 'bad' },
};
const PRIORITY: Record<number, string> = { 1: 'Alta', 2: 'Média', 3: 'Baixa' };

function TreatmentPlan({ patientId, canWrite, hasFinance, teeth, reloadKey }: { patientId: string; canWrite: boolean; hasFinance: boolean; teeth: string[]; reloadKey: number }) {
  const toast = useToast();
  const plan = useLoad(() => get<{ items: PlanItem[]; openTotalCents: string }>(`/api/patients/${patientId}/dental-plan`), [patientId, reloadKey]);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ procedure: '', tooth: '', price: '', priority: '2' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    const cents = f.price ? parseMoney(f.price) : 0;
    if (f.procedure.trim().length < 2) return setError('Informe o procedimento.');
    if (cents === null) return setError('Informe o valor como 250,00.');
    setBusy(true); setError(null);
    try {
      await post(`/api/patients/${patientId}/dental-plan`, { procedure: f.procedure, tooth: f.tooth || undefined, priceCents: cents, priority: Number(f.priority) });
      toast('Item adicionado ao plano.'); setAdding(false); setF({ procedure: '', tooth: '', price: '', priority: '2' }); plan.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function move(item: PlanItem, status: string, charge = false) {
    if (status === 'cancelled' && !window.confirm(`Cancelar "${item.procedure}"? Esta ação não pode ser desfeita.`)) return;
    try {
      const r = await patch<{ charged: boolean }>(`/api/dental-plan/${item.id}`, { status, charge });
      toast(r.charged ? 'Procedimento concluído e cobrança gerada.' : 'Plano atualizado.'); plan.reload();
    } catch (err) { toast((err as Error).message, 'bad'); }
  }

  return (
    <section className="card" aria-labelledby="plan-title">
      <div className="row between">
        <h2 id="plan-title">Plano de tratamento</h2>
        {canWrite && <Button className="btn-sm" onClick={() => setAdding(true)}>Adicionar item</Button>}
      </div>
      {plan.loading && !plan.data && <Spinner />}
      {plan.error && <ErrorBox message={plan.error} onRetry={plan.reload} />}
      {plan.data && <p className="small">Em aberto: <strong>{brl(plan.data.openTotalCents)}</strong></p>}
      {plan.data?.items.length === 0 && <Empty title="Nenhum procedimento planejado" />}
      <ul className="list">
        {plan.data?.items.map((i) => (
          <li key={i.id} className="list-item stack">
            <div className="row between"><strong>{i.procedure}{i.tooth ? ` · dente ${i.tooth}` : ''}</strong><Badge tone={STATUS[i.status]!.tone}>{STATUS[i.status]!.label}</Badge></div>
            <span className="small muted">Prioridade {PRIORITY[i.priority]} · {Number(i.priceCents) > 0 ? brl(i.priceCents) : 'sem valor'}</span>
            {canWrite && (i.status === 'planned' || i.status === 'in_progress') && (
              <div className="row">
                {i.status === 'planned' && <Button variant="secondary" className="btn-sm" onClick={() => move(i, 'in_progress')}>Iniciar</Button>}
                {hasFinance && Number(i.priceCents) > 0 && <Button className="btn-sm" onClick={() => move(i, 'done', true)}>Concluir e cobrar</Button>}
                <Button variant="secondary" className="btn-sm" onClick={() => move(i, 'done')}>Concluir</Button>
                <Button variant="danger" className="btn-sm" onClick={() => move(i, 'cancelled')}>Cancelar</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <Sheet open={adding} title="Novo item do plano" onClose={() => setAdding(false)}>
        <form onSubmit={add} noValidate>
          <TextInput label="Procedimento" value={f.procedure} onChange={(v) => setF({ ...f, procedure: v })} hint="Exemplo: Restauração em resina." />
          <Select label="Dente" value={f.tooth} onChange={(v) => setF({ ...f, tooth: v })}><option value="">Geral (sem dente específico)</option>{teeth.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
          <div className="grid2">
            <TextInput label="Valor (R$)" value={f.price} onChange={(v) => setF({ ...f, price: v })} inputMode="decimal" placeholder="250,00" />
            <Select label="Prioridade" value={f.priority} onChange={(v) => setF({ ...f, priority: v })}><option value="1">Alta</option><option value="2">Média</option><option value="3">Baixa</option></Select>
          </div>
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Adicionar ao plano</Button>
        </form>
      </Sheet>
    </section>
  );
}
