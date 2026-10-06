import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';

export function Field({ label, error, hint, children }: { label: string; error?: string | null; hint?: string; children: (id: string, describedBy?: string) => ReactNode }) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(id, error || hint ? msgId : undefined)}
      {error ? <p id={msgId} className="field-msg error" role="alert">{error}</p> : hint ? <p id={msgId} className="field-msg">{hint}</p> : null}
    </div>
  );
}

export function TextInput({ label, value, onChange, type = 'text', error, hint, required, autoComplete, inputMode, maxLength, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; error?: string | null; hint?: string;
  required?: boolean; autoComplete?: string; inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email'; maxLength?: number; placeholder?: string;
}) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(id, d) => (
        <input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} required={required}
          autoComplete={autoComplete} inputMode={inputMode} maxLength={maxLength} placeholder={placeholder}
          aria-describedby={d} aria-invalid={error ? true : undefined} />
      )}
    </Field>
  );
}

export function Select({ label, value, onChange, children, error }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode; error?: string | null }) {
  return (
    <Field label={label} error={error}>
      {(id, d) => <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={d}>{children}</select>}
    </Field>
  );
}

export function Button({ children, variant = 'primary', busy, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean }) {
  return (
    <button {...rest} className={`btn btn-${variant}${rest.className ? ` ${rest.className}` : ''}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy ? 'Aguarde…' : children}
    </button>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Spinner({ label = 'Carregando…' }: { label?: string }) {
  return <p className="loading" role="status"><span className="spinner" aria-hidden="true" />{label}</p>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><p className="empty-title">{title}</p>{children}</div>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="errorbox" role="alert">
      <p>{message}</p>
      {onRetry && <Button variant="secondary" onClick={onRetry}>Tentar novamente</Button>}
    </div>
  );
}

/** Sheet: <dialog> nativo (foco preso, ESC fecha, restaura foco). Vira bottom-sheet no celular. */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="sheet" onClose={onClose} onCancel={onClose} aria-labelledby="sheet-title"
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {open && (
        <div className="sheet-body">
          <header className="sheet-head">
            <h2 id="sheet-title">{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Fechar">✕</button>
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}

const ToastCtx = createContext<(msg: string, tone?: 'ok' | 'bad') => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; tone: 'ok' | 'bad' }[]>([]);
  const push = useCallback((msg: string, tone: 'ok' | 'bad' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, msg, tone }].slice(-3)); // no máximo 3 avisos visíveis
    setTimeout(() => setItems((s) => s.filter((i) => i.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((i) => <div key={i.id} className={`toast toast-${i.tone}`}>{i.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/** Carrega dados com estados de loading/erro e recarga. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    loader().then(
      (data) => alive && setState({ data, loading: false }),
      (e: Error) => alive && setState({ error: e.message, loading: false }),
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export function useHash(): [string, (h: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [hash, (h) => { window.location.hash = h; }];
}
