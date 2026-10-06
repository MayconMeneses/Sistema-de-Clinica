import { useState, type FormEvent } from 'react';
import { get, patch, post } from '../api';
import { dateTimeOf, ROLE_LABEL } from '../format';
import { Badge, Button, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';
import { Blocks, Hours, UnitsRooms } from './Settings';

interface User { id: string; name: string; email: string; role: string; status: string; mfaEnabled: boolean }
interface AuditEvent { id: string; occurredAt: string; action: string; entityType: string; actorName: string | null }

type Tab = 'team' | 'units' | 'hours' | 'blocks' | 'audit';

export function Team({ permissions }: { permissions: string[] }) {
  const can = (p: string) => permissions.includes(p);
  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: 'team', label: 'Usuários', show: can('users.manage') },
    { key: 'units', label: 'Unidades e salas', show: can('org.manage') },
    { key: 'hours', label: 'Horários', show: can('schedule.manage') || can('org.manage') },
    { key: 'blocks', label: 'Bloqueios', show: can('schedule.manage') || can('org.manage') },
    { key: 'audit', label: 'Auditoria', show: can('audit.read') },
  ];
  const visible = tabs.filter((t) => t.show);
  const [tab, setTab] = useState<Tab>(visible[0]?.key ?? 'team');
  return (
    <>
      <div className="page-head"><h1>Gestão</h1></div>
      <div className="tabs" role="tablist">
        {visible.map((t) => <button key={t.key} role="tab" className="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>{t.label}</button>)}
      </div>
      {tab === 'team' && <Users />}
      {tab === 'units' && <UnitsRooms canManage={can('org.manage')} />}
      {tab === 'hours' && <Hours canManage={can('schedule.manage')} />}
      {tab === 'blocks' && <Blocks canManage={can('schedule.manage')} />}
      {tab === 'audit' && <Audit />}
    </>
  );
}

function Users() {
  const toast = useToast();
  const list = useLoad(() => get<{ users: User[] }>('/api/users'), []);
  const [adding, setAdding] = useState(false);
  const [resetFor, setResetFor] = useState<User | null>(null);

  async function resetMfa(u: User) {
    if (!window.confirm(`Redefinir a verificação em duas etapas de ${u.name}? A pessoa será desconectada e poderá configurar de novo.`)) return;
    try { await patch(`/api/users/${u.id}`, { resetMfa: true }); toast('Verificação em duas etapas redefinida.'); list.reload(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  }

  async function toggle(u: User) {
    const status = u.status === 'active' ? 'suspended' : 'active';
    if (status === 'suspended' && !window.confirm(`Suspender ${u.name}? O acesso será bloqueado imediatamente.`)) return;
    try { await patch(`/api/users/${u.id}`, { status }); toast(status === 'suspended' ? 'Acesso suspenso.' : 'Acesso reativado.'); list.reload(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  }

  return (
    <>
      <div className="row between"><span /><Button onClick={() => setAdding(true)}>Adicionar usuário</Button></div>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      <ul className="list">
        {list.data?.users.map((u) => (
          <li key={u.id} className="list-item stack">
            <div className="row between"><strong>{u.name}</strong><span className="row">{u.mfaEnabled && <Badge tone="info">2 etapas</Badge>}{u.status === 'active' ? <Badge tone="ok">Ativo</Badge> : <Badge tone="bad">Suspenso</Badge>}</span></div>
            <span className="muted small">{u.email} · {ROLE_LABEL[u.role] ?? u.role}</span>
            {u.role !== 'owner' && (
              <div className="row">
                <Button variant="secondary" className="btn-sm" onClick={() => toggle(u)}>{u.status === 'active' ? 'Suspender' : 'Reativar'}</Button>
                <Button variant="secondary" className="btn-sm" onClick={() => setResetFor(u)}>Redefinir senha</Button>
                {u.mfaEnabled && <Button variant="secondary" className="btn-sm" onClick={() => resetMfa(u)}>Redefinir 2 etapas</Button>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <AddUser open={adding} onClose={() => setAdding(false)} onDone={() => { setAdding(false); list.reload(); }} />
      <ResetPassword user={resetFor} onClose={() => setResetFor(null)} />
    </>
  );
}

function AddUser({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', email: '', role: 'receptionist', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (f.password.length < 10) return setError('A senha provisória deve ter ao menos 10 caracteres.');
    setBusy(true);
    try { await post('/api/users', f); toast('Usuário criado.'); setF({ name: '', email: '', role: 'receptionist', password: '' }); onDone(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <Sheet open={open} title="Adicionar usuário" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <TextInput label="Nome" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
        <TextInput label="E-mail" type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} inputMode="email" />
        <Select label="Perfil" value={f.role} onChange={(v) => setF({ ...f, role: v })}>
          {['receptionist', 'professional', 'finance', 'admin'].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </Select>
        <TextInput label="Senha provisória" type="password" value={f.password} onChange={(v) => setF({ ...f, password: v })} autoComplete="new-password" hint="Mínimo de 10 caracteres. Peça para a pessoa trocar no primeiro acesso." />
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" busy={busy} className="btn-block">Criar usuário</Button>
      </form>
    </Sheet>
  );
}

function ResetPassword({ user, onClose }: { user: User | null; onClose: () => void }) {
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (pw.length < 10) return setError('A senha deve ter ao menos 10 caracteres.');
    try { await patch(`/api/users/${user.id}`, { password: pw }); toast('Senha redefinida. Sessões antigas foram encerradas.'); setPw(''); onClose(); }
    catch (err) { setError((err as Error).message); }
  }
  return (
    <Sheet open={!!user} title={`Redefinir senha de ${user?.name ?? ''}`} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <TextInput label="Nova senha" type="password" value={pw} onChange={setPw} autoComplete="new-password" error={error} />
        <Button type="submit" className="btn-block">Redefinir senha</Button>
      </form>
    </Sheet>
  );
}

function Audit() {
  const a = useLoad(() => get<{ events: AuditEvent[] }>('/api/audit'), []);
  if (a.loading && !a.data) return <Spinner />;
  if (a.error) return <ErrorBox message={a.error} onRetry={a.reload} />;
  return (
    <ul className="list">
      {a.data?.events.map((e) => (
        <li key={e.id} className="list-item"><strong>{e.action}</strong><br /><span className="muted small">{e.actorName ?? 'Sistema'} · {dateTimeOf(e.occurredAt)}</span></li>
      ))}
    </ul>
  );
}
