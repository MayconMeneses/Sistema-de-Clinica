import { useState, type FormEvent } from 'react';
import { ApiError, post } from '../api';
import { Button, TextInput } from '../ui';
import { useMasterMfa } from '../useMfa';

export function Login({ mode, onDone }: { mode: 'clinic' | 'master'; onDone: () => void }) {
  const [clinic, setClinic] = useState(() => { try { return localStorage.getItem('last-clinic') ?? ''; } catch { return ''; } });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const masterMfa = useMasterMfa();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'clinic') {
        await post('/api/auth/login', { clinic, email, password, ...(needCode ? { code } : {}) });
        try { localStorage.setItem('last-clinic', clinic.trim().toLowerCase()); } catch { /* opcional */ }
      } else {
        await post('/api/master/login', { email, password, ...(masterMfa ? { code } : {}) });
      }
      setPassword(''); setCode('');
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') setNeedCode(true);
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <main className="auth">
      <div className="card auth-card">
        <div className="brand"><span className="brand-mark" aria-hidden="true">C</span>Clínica One</div>
        <div className="switch" role="group" aria-label="Tipo de acesso">
          <button type="button" aria-pressed={mode === 'clinic'} onClick={() => { window.location.hash = '/'; }}>Sou da clínica</button>
          <button type="button" aria-pressed={mode === 'master'} onClick={() => { window.location.hash = '/master'; }}>Plataforma</button>
        </div>
        <form onSubmit={submit} noValidate>
          <h1>{mode === 'clinic' ? 'Entrar na clínica' : 'Painel da plataforma'}</h1>
          {mode === 'clinic' && <TextInput label="Identificador da clínica" value={clinic} onChange={setClinic} required autoComplete="organization" hint="Exemplo: demo" />}
          <TextInput label="E-mail" type="email" value={email} onChange={setEmail} required autoComplete="username" inputMode="email" />
          <TextInput label="Senha" type="password" value={password} onChange={setPassword} required autoComplete="current-password" />
          {((mode === 'master' && masterMfa) || needCode) && <TextInput label={mode === 'master' ? 'Código MFA (6 dígitos)' : 'Código do autenticador (6 dígitos)'} value={code} onChange={setCode} required inputMode="numeric" autoComplete="one-time-code" maxLength={6} />}
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Entrar</Button>
          {mode === 'clinic' && <p className="small"><a href="#/esqueci">Esqueci minha senha</a></p>}
        </form>
      </div>
    </main>
  );
}
