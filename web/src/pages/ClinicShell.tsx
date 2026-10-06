import { useState } from 'react';
import { post, type Me } from '../api';
import { ROLE_LABEL } from '../format';
import { Button, Sheet, TextInput, useToast } from '../ui';
import { Agenda } from './Agenda';
import { Dashboard } from './Dashboard';
import { FinancePage } from './Finance';
import { PatientDetail, Patients } from './Patients';
import { Team } from './Team';

interface NavItem { path: string; label: string; ico: string; show: boolean }

export function ClinicShell({ me, hash, onLogout }: { me: Me; hash: string; onLogout: () => void }) {
  const can = (p: string) => me.permissions.includes(p);
  const has = (c: string) => me.entitlements.includes(c);
  const items: NavItem[] = [
    { path: '/', label: 'Início', ico: '⌂', show: true },
    { path: '/agenda', label: 'Agenda', ico: '▦', show: has('schedule.core') && can('agenda.read') },
    { path: '/pacientes', label: 'Pacientes', ico: '☺', show: has('patient.registry') && can('patients.read') },
    { path: '/financeiro', label: 'Financeiro', ico: '$', show: has('finance.basic') && can('finance.read') },
    { path: '/equipe', label: 'Equipe', ico: '⚙', show: can('users.manage') },
  ];
  const visible = items.filter((i) => i.show);
  const [menu, setMenu] = useState(false);

  const patientMatch = /^\/pacientes\/([0-9a-f-]{36})$/i.exec(hash);
  const current = patientMatch ? '/pacientes' : hash.split('?')[0]!;
  let page;
  if (patientMatch) page = <PatientDetail id={patientMatch[1]!} me={me} />;
  else if (current === '/agenda' && visible.some((i) => i.path === '/agenda')) page = <Agenda me={me} />;
  else if (current === '/pacientes' && visible.some((i) => i.path === '/pacientes')) page = <Patients me={me} />;
  else if (current === '/financeiro' && visible.some((i) => i.path === '/financeiro')) page = <FinancePage />;
  else if (current === '/equipe' && visible.some((i) => i.path === '/equipe')) page = <Team />;
  else page = <Dashboard me={me} />;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="title">{me.clinic.name}</span>
        <Button variant="ghost" className="btn-sm" onClick={() => setMenu(true)} aria-label={`Conta de ${me.user.name}`}>{me.user.name.split(' ')[0]} ▾</Button>
      </header>
      <nav className="nav" aria-label="Principal">
        {visible.map((i) => (
          <a key={i.path} href={`#${i.path}`} aria-current={current === i.path ? 'page' : undefined}>
            <span className="ico" aria-hidden="true">{i.ico}</span>{i.label}
          </a>
        ))}
      </nav>
      <main className="content" id="main">{page}</main>
      <AccountSheet open={menu} me={me} onClose={() => setMenu(false)} onLogout={onLogout} />
    </div>
  );
}

function AccountSheet({ open, me, onClose, onLogout }: { open: boolean; me: Me; onClose: () => void; onLogout: () => void }) {
  const toast = useToast();
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function logout() {
    try { await post('/api/auth/logout'); } finally { onLogout(); }
  }
  async function change(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 10) { setError('A nova senha deve ter ao menos 10 caracteres.'); return; }
    setBusy(true);
    try {
      await post('/api/me/password', { current, next });
      toast('Senha alterada. Os outros dispositivos foram desconectados.');
      setChanging(false); setCurrent(''); setNext(''); onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} title="Minha conta" onClose={onClose}>
      <p><strong>{me.user.name}</strong><br /><span className="muted">{me.user.email} · {ROLE_LABEL[me.user.role] ?? me.user.role}</span></p>
      {changing ? (
        <form onSubmit={change} noValidate>
          <TextInput label="Senha atual" type="password" value={current} onChange={setCurrent} autoComplete="current-password" />
          <TextInput label="Nova senha" type="password" value={next} onChange={setNext} autoComplete="new-password" hint="Mínimo de 10 caracteres." />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <div className="row"><Button type="submit" busy={busy}>Salvar nova senha</Button><Button type="button" variant="secondary" onClick={() => setChanging(false)}>Cancelar</Button></div>
        </form>
      ) : (
        <div className="stack">
          <Button variant="secondary" className="btn-block" onClick={() => setChanging(true)}>Alterar senha</Button>
          <Button variant="danger" className="btn-block" onClick={logout}>Sair</Button>
        </div>
      )}
    </Sheet>
  );
}
