import { useState, type FormEvent } from 'react';
import { Button, ErrorBox, Sheet, Spinner, TextInput, useLoad } from '../ui';

export interface FormField {
  id: string; label: string; type: 'text' | 'longtext' | 'yesno' | 'choice' | 'multichoice' | 'number' | 'date' | 'scale';
  required?: boolean; help?: string; options?: string[]; min?: number; max?: number;
}
type Answers = Record<string, unknown>;

/** Renderiza os campos do modelo e devolve só o que foi respondido (vazio não vai). Quem valida de verdade é o servidor. */
export function FormFields({ fields, value, onChange }: { fields: FormField[]; value: Answers; onChange: (v: Answers) => void }) {
  const set = (id: string, v: unknown) => onChange({ ...value, [id]: v });
  return (
    <>
      {fields.map((f) => {
        const label = f.label + (f.required ? ' *' : '');
        const v = value[f.id];
        switch (f.type) {
          case 'text': return <TextInput key={f.id} label={label} value={(v as string) ?? ''} onChange={(x) => set(f.id, x)} hint={f.help} maxLength={200} />;
          case 'longtext': return (
            <div key={f.id} className="field"><label className="label" htmlFor={`f-${f.id}`}>{label}</label>
              <textarea id={`f-${f.id}`} className="input" rows={4} maxLength={2000} value={(v as string) ?? ''} onChange={(e) => set(f.id, e.target.value)} />{f.help && <span className="field-msg">{f.help}</span>}</div>);
          case 'number': return <TextInput key={f.id} label={label} inputMode="decimal" value={v === undefined ? '' : String(v)} hint={f.help} onChange={(x) => set(f.id, x === '' ? undefined : Number(x.replace(',', '.')))} />;
          case 'date': return <TextInput key={f.id} label={label} type="date" value={(v as string) ?? ''} onChange={(x) => set(f.id, x)} hint={f.help} />;
          case 'yesno': return (
            <fieldset key={f.id} className="field"><legend className="label">{label}</legend>
              <div className="row">{[true, false].map((b) => <label key={String(b)} className="row"><input type="radio" name={`f-${f.id}`} checked={v === b} onChange={() => set(f.id, b)} /> {b ? 'Sim' : 'Não'}</label>)}</div></fieldset>);
          case 'choice': return (
            <fieldset key={f.id} className="field"><legend className="label">{label}</legend>
              <div className="stack">{f.options!.map((o) => <label key={o} className="row"><input type="radio" name={`f-${f.id}`} checked={v === o} onChange={() => set(f.id, o)} /> {o}</label>)}</div></fieldset>);
          case 'multichoice': {
            const cur = (v as string[] | undefined) ?? [];
            return (
              <fieldset key={f.id} className="field"><legend className="label">{label}</legend>
                <div className="stack">{f.options!.map((o) => <label key={o} className="row"><input type="checkbox" checked={cur.includes(o)} onChange={(e) => set(f.id, e.target.checked ? [...cur, o] : cur.filter((x) => x !== o))} /> {o}</label>)}</div></fieldset>);
          }
          case 'scale': {
            const lo = f.min ?? 0, hi = f.max ?? 10;
            return (
              <fieldset key={f.id} className="field"><legend className="label">{label}</legend>
                <div className="row" style={{ flexWrap: 'wrap' }}>{Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((n) => (
                  <label key={n} className="row"><input type="radio" name={`f-${f.id}`} checked={v === n} onChange={() => set(f.id, n)} /> {n}</label>))}</div></fieldset>);
          }
        }
      })}
    </>
  );
}

/** Sheet que carrega as perguntas, deixa responder e envia. `base` é '/api/portal/forms' ou '/api/forms'. */
export function FormSheet({ id, base, get, post, onClose, onDone }: {
  id: string | null; base: string; get: <T>(p: string) => Promise<T>; post: (p: string, b?: unknown) => Promise<unknown>; onClose: () => void; onDone: () => void;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useLoad(() => (id ? get<{ name: string; fields: FormField[] }>(`${base}/${id}`) : Promise.resolve(null)), [id]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!id) return;
    setBusy(true); setError(null);
    try { await post(`${base}/${id}/submit`, { answers }); setAnswers({}); onDone(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <Sheet open={!!id} title={form.data?.name ?? 'Formulário'} onClose={onClose}>
      {form.loading && !form.data && <Spinner />}
      {form.error && <ErrorBox message={form.error} onRetry={form.reload} />}
      {form.data && (
        <form onSubmit={submit} noValidate>
          <FormFields fields={form.data.fields} value={answers} onChange={setAnswers} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Enviar respostas</Button>
        </form>
      )}
    </Sheet>
  );
}
