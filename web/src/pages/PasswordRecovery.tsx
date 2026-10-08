import { useState, type FormEvent } from 'react';
import { post } from '../api';
import { Button, TextInput } from '../ui';

const back = () => { window.location.hash = '/'; };

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className="card auth-card">
        <div className="brand"><span className="brand-mark" aria-hidden="true">C</span>Clínica One</div>
        <h1>{title}</h1>
        {children}
        <p className="small"><a href="#/" onClick={back}>← Voltar para a entrada</a></p>
      </div>
    </main>
  );
}

export function ForgotPassword() {
  const [clinic, setClinic] = useState(() => { try { return localStorage.getItem('last-clinic') ?? ''; } catch { return ''; } });
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!clinic.trim() || !email.includes('@')) { setError('Informe o identificador da clínica e o e-mail cadastrado.'); return; }
    setBusy(true);
    try { setSent((await post<{ message: string }>('/api/auth/forgot', { clinic, email })).message); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <Frame title="Esqueci minha senha">
      {sent ? <p role="status">{sent}</p> : (
        <form onSubmit={submit} noValidate>
          <TextInput label="Identificador da clínica" value={clinic} onChange={setClinic} required autoComplete="organization" />
          <TextInput label="E-mail cadastrado" type="email" value={email} onChange={setEmail} required autoComplete="username" inputMode="email" />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Enviar link de redefinição</Button>
        </form>
      )}
    </Frame>
  );
}

export function ResetPassword({ hash }: { hash: string }) {
  const q = new URLSearchParams(hash.split('?')[1] ?? '');
  const clinic = q.get('clinic') ?? '';
  const token = q.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (password !== again) { setError('As senhas não são iguais.'); return; }
    setBusy(true);
    try { setDone((await post<{ message: string }>('/api/auth/reset', { clinic, token, password })).message); setPassword(''); setAgain(''); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  if (!clinic || !token) return <Frame title="Link incompleto"><p role="alert">O link está incompleto. Peça um novo na tela de entrada, em “Esqueci minha senha”.</p></Frame>;
  return (
    <Frame title="Criar nova senha">
      {done ? <p role="status">{done}</p> : (
        <form onSubmit={submit} noValidate>
          <TextInput label="Nova senha" type="password" value={password} onChange={setPassword} required autoComplete="new-password" hint="Mínimo de 10 caracteres." />
          <TextInput label="Repita a nova senha" type="password" value={again} onChange={setAgain} required autoComplete="new-password" />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} className="btn-block">Salvar nova senha</Button>
        </form>
      )}
    </Frame>
  );
}
