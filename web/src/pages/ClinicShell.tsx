import { useState } from 'react';
import { post, type Me } from '../api';
import { ROLE_LABEL } from '../format';
import { Button, Sheet, TextInput, useToast } from '../ui';
import { MfaPanel } from './Mfa';
import { Agenda } from './Agenda';
import { Dashboard } from './Dashboard';
import { Reception } from './Reception';
import { FinancePage } from './Finance';
import { Receipt } from './Receipt';
import { CrmPage } from './Crm';
import { InventoryPage } from './Inventory';
import { ReportsPage } from './Reports';
import { PatientDetail, Patients } from './Patients';
import { Team } from './Team';

interface NavItem { path: string; label: string; ico: string; show: boolean }

export function ClinicShell({ me, hash, onLogout, onRefresh }: { me: Me; hash: string; onLogout: () => void; onRefresh: () => void }) {
  const can = (p: string) => me.permissions.includes(p);
  const has = (c: string) => me.entitlements.includes(c);
  const items: NavItem[] = [
    { path: '/', label: 'Início', ico: '⌂', show: true },
    { path: '/agenda', label: 'Agenda', ico: '▦', show: has('schedule.core') && can('agenda.read') },
    { path: '/recepcao', label: 'Recepção', ico: '☎', show: has('schedule.core') && can('agenda.read') },
    { path: '/pacientes', label: 'Pacientes', ico: '☺', show: has('patient.registry') && can('patients.read') },
    { path: '/financeiro', label: 'Financeiro', ico: '$', show: has('finance.basic') && can('finance.read') },
    { path: '/estoque', label: 'Estoque', ico: '▤', show: has('inventory.core') && can('inventory.read') },
    { path: '/crm', label: 'CRM', ico: '☆', show: has('crm.pipeline') && can('crm.read') },
    { path: '/indicadores', label: 'Indicadores', ico: '◔', show: has('analytics.bi') && can('reports.read') },
    { path: '/equipe', label: 'Gestão', ico: '⚙', show: can('users.manage') || can('org.manage') || can('schedule.manage') || can('audit.read') },
  ];
  const visible = items.filter((i) => i.show);
  // No celular cabem 5 itens: com mais que isso, os 4 primeiros ficam no menu e o restante fica atrás de "Mais".
  const overflow = visible.length > 5;
  const extra = overflow ? visible.slice(4) : [];
  const [menu, setMenu] = useState(false);

  const patientMatch = /^\/pacientes\/([0-9a-f-]{36})$/i.exec(hash);
  const receiptMatch = /^\/recibo\/([0-9a-f-]{36})$/i.exec(hash);
  const current = patientMatch ? '/pacientes' : receiptMatch ? '/financeiro' : hash.split('?')[0]!;
  let page;
  if (receiptMatch && can('finance.read') && has('finance.basic')) page = <Receipt id={receiptMatch[1]!} />;
  else if (patientMatch) page = <PatientDetail id={patientMatch[1]!} me={me} />;
  else if (current === '/agenda' && visible.some((i) => i.path === '/agenda')) page = <Agenda me={me} />;
  else if (current === '/recepcao' && visible.some((i) => i.path === '/recepcao')) page = <Reception canWrite={can('agenda.write')} />;
  else if (current === '/pacientes' && visible.some((i) => i.path === '/pacientes')) page = <Patients me={me} />;
  else if (current === '/financeiro' && visible.some((i) => i.path === '/financeiro')) page = <FinancePage me={me} />;
  else if (current === '/equipe' && visible.some((i) => i.path === '/equipe')) page = <Team permissions={me.permissions} />;
  else if (current === '/estoque' && visible.some((i) => i.path === '/estoque')) page = <InventoryPage canWrite={can('inventory.write')} />;
  else if (current === '/crm' && visible.some((i) => i.path === '/crm')) page = <CrmPage canWrite={can('crm.write')} canConvert={can('patients.write')} />;
  else if (current === '/indicadores' && visible.some((i) => i.path === '/indicadores')) page = <ReportsPage />;
  else if (current === '/mais' && overflow) page = <MorePage items={extra} />;
  else page = <Dashboard me={me} />;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="title">{me.clinic.name}</span>
        <Button variant="ghost" className="btn-sm" onClick={() => setMenu(true)} aria-label={`Conta de ${me.user.name}`}>{me.user.name.split(' ')[0]} ▾</Button>
      </header>
      <nav className="nav" aria-label="Principal">
        {visible.map((i, n) => (
          <a key={i.path} href={`#${i.path}`} className={overflow && n >= 4 ? 'nav-extra' : undefined} aria-current={current === i.path ? 'page' : undefined}>
            <span className="ico" aria-hidden="true">{i.ico}</span><span className="lbl">{i.label}</span>
          </a>
        ))}
        {overflow && (
          <a href="#/mais" className="nav-more" aria-current={current === '/mais' || extra.some((e) => e.path === current) ? 'page' : undefined}>
            <span className="ico" aria-hidden="true">≡</span><span className="lbl">Mais</span>
          </a>
        )}
      </nav>
      <main className="content" id="main">{page}</main>
      <AccountSheet open={menu} me={me} onClose={() => setMenu(false)} onLogout={onLogout} onRefresh={onRefresh} />
    </div>
  );
}

function MorePage({ items }: { items: NavItem[] }) {
  return (
    <>
      <div className="page-head"><h1>Mais</h1></div>
      <ul className="list">
        {items.map((i) => <li key={i.path}><a className="list-item link" href={`#${i.path}`}><span aria-hidden="true">{i.ico}</span> {i.label}</a></li>)}
      </ul>
    </>
  );
}

function AccountSheet({ open, me, onClose, onLogout, onRefresh }: { open: boolean; me: Me; onClose: () => void; onLogout: () => void; onRefresh: () => void }) {
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
          <MfaPanel enabled={me.mfaEnabled} onChanged={onRefresh} />
          <Button variant="secondary" className="btn-block" onClick={() => setChanging(true)}>Alterar senha</Button>
          <Button variant="danger" className="btn-block" onClick={logout}>Sair</Button>
        </div>
      )}
    </Sheet>
  );
}
