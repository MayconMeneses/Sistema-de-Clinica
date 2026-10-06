import { useState, type FormEvent } from 'react';
import { post } from '../api';
import { Button, TextInput, useToast } from '../ui';

/** Ativar/desativar verificação em duas etapas (TOTP). O link otpauth:// abre o app autenticador no celular. */
export function MfaPanel({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState<'idle' | 'password' | 'code' | 'disable'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const reset = () => { setStep('idle'); setPassword(''); setCode(''); setSetup(null); setError(null); };

  const start = (e: FormEvent) => { e.preventDefault(); void run(async () => { setSetup(await post('/api/me/mfa/setup', { password })); setPassword(''); setStep('code'); }); };
  const enable = (e: FormEvent) => { e.preventDefault(); void run(async () => { await post('/api/me/mfa/enable', { code }); toast('Verificação em duas etapas ativada.'); reset(); onChanged(); }); };
  const disable = (e: FormEvent) => { e.preventDefault(); void run(async () => { await post('/api/me/mfa/disable', { password, code }); toast('Verificação em duas etapas desativada.'); reset(); onChanged(); }); };

  return (
    <section className="card" aria-labelledby="mfa-title">
      <h3 id="mfa-title">Verificação em duas etapas</h3>
      {step === 'idle' && (
        enabled
          ? <><p className="small">Ativa. Ao entrar, você informa o código do aplicativo autenticador.</p><Button variant="secondary" onClick={() => setStep('disable')}>Desativar</Button></>
          : <><p className="small muted">Adicione uma segunda camada de proteção à sua conta com um aplicativo autenticador.</p><Button variant="secondary" onClick={() => setStep('password')}>Ativar</Button></>
      )}
      {step === 'password' && (
        <form onSubmit={start} noValidate>
          <TextInput label="Confirme sua senha" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <div className="row"><Button type="submit" busy={busy}>Continuar</Button><Button type="button" variant="secondary" onClick={reset}>Cancelar</Button></div>
        </form>
      )}
      {step === 'code' && setup && (
        <form onSubmit={enable} noValidate>
          <p className="small">1. No celular, toque para abrir seu aplicativo autenticador:</p>
          <p><a className="btn btn-secondary" href={setup.otpauth}>Abrir no aplicativo</a></p>
          <p className="small">Ou digite esta chave manualmente: <code className="pre">{setup.secret}</code></p>
          <p className="small">2. Informe o código de 6 dígitos que o aplicativo mostrar:</p>
          <TextInput label="Código de 6 dígitos" value={code} onChange={setCode} inputMode="numeric" maxLength={6} autoComplete="one-time-code" />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <div className="row"><Button type="submit" busy={busy}>Ativar verificação</Button><Button type="button" variant="secondary" onClick={reset}>Cancelar</Button></div>
        </form>
      )}
      {step === 'disable' && (
        <form onSubmit={disable} noValidate>
          <TextInput label="Senha" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
          <TextInput label="Código de 6 dígitos" value={code} onChange={setCode} inputMode="numeric" maxLength={6} autoComplete="one-time-code" />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <div className="row"><Button type="submit" variant="danger" busy={busy}>Desativar verificação</Button><Button type="button" variant="secondary" onClick={reset}>Cancelar</Button></div>
        </form>
      )}
    </section>
  );
}
