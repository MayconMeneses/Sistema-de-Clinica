import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { get, patch, post } from '../api';
import { dateTimeOf } from '../format';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';
import { Login } from './Login';

interface Capability { code: string; description: string; globallyAvailable: boolean; dependsOn: string[] }
interface Tenant { id: string; slug: string; name: string; status: string; planCode: string; createdAt: string; overrides: { capability: string; mode: 'grant' | 'block'; reason: string }[]; effective: string[] }
interface Overview { plans: { code: string; name: string }[]; capabilities: Capability[]; tenants: Tenant[] }
const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = { active: 'ok', suspended: 'warn', closed: 'bad', provisioning: 'neutral' };
const STATUS_TEXT: Record<string, string> = { active: 'Ativa', suspended: 'Suspensa', closed: 'Encerrada', provisioning: 'Em provisionamento' };

export function MasterApp({ hash }: { hash: string }) {
  const [op, setOp] = useState<{ name: string; email: string } | null | undefined>(undefined);
  const refresh = useCallback(() => { get<{ operator: { name: string; email: string } }>('/api/master/me').then((r) => setOp(r.operator), () => setOp(null)); }, []);
  useEffect(() => {
    refresh();
    const expired = () => setOp(null);
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, [refresh]);

  if (op === undefined) return <main className="auth"><p className="loading" role="status">Carregando…</p></main>;
  if (op === null) return <Login mode="master" onDone={refresh} />;

  const section = hash.startsWith('/master/funcionalidades') ? 'caps' : hash.startsWith('/master/auditoria') ? 'audit' : 'tenants';
  const links = [
    { to: '/master', key: 'tenants', label: 'Clínicas', ico: '▣' },
    { to: '/master/funcionalidades', key: 'caps', label: 'Planos', ico: '◧' },
    { to: '/master/auditoria', key: 'audit', label: 'Auditoria', ico: '☰' },
  ];
  return (
    <div className="shell master-mode">
      <header className="topbar">
        <span className="title">Clínica One<span className="pill-master">PLATAFORMA</span></span>
        <Button variant="ghost" className="btn-sm" onClick={async () => { try { await post('/api/master/logout'); } finally { setOp(null); } }}>Sair</Button>
      </header>
      <nav className="nav" aria-label="Plataforma">
        {links.map((l) => <a key={l.key} href={`#${l.to}`} aria-current={section === l.key ? 'page' : undefined}><span className="ico" aria-hidden="true">{l.ico}</span>{l.label}</a>)}
      </nav>
      <main className="content">
        {section === 'tenants' && <Tenants />}
        {section === 'caps' && <Plans />}
        {section === 'audit' && <PlatformAudit />}
      </main>
    </div>
  );
}

function Tenants() {
  const ov = useLoad(() => get<Overview>('/api/master/overview'), []);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const tenant = ov.data?.tenants.find((t) => t.id === selected) ?? null;
  return (
    <>
      <div className="page-head"><h1>Clínicas</h1><Button onClick={() => setCreating(true)}>Nova clínica</Button></div>
      {ov.loading && !ov.data && <Spinner />}
      {ov.error && <ErrorBox message={ov.error} onRetry={ov.reload} />}
      {ov.data?.tenants.length === 0 && <Empty title="Nenhuma clínica">Crie a primeira clínica cliente.</Empty>}
      <ul className="list">
        {ov.data?.tenants.map((t) => (
          <li key={t.id}>
            <button className="list-item link btn-block" onClick={() => setSelected(t.id)}>
              <div className="row between"><strong>{t.name}</strong><Badge tone={STATUS_TONE[t.status]}>{STATUS_TEXT[t.status]}</Badge></div>
              <span className="muted small">{t.slug} · plano {ov.data!.plans.find((p) => p.code === t.planCode)?.name} · {t.effective.length} funcionalidades{t.overrides.length ? ` · ${t.overrides.length} ajuste(s)` : ''}</span>
            </button>
          </li>
        ))}
      </ul>
      {ov.data && <CreateTenant open={creating} plans={ov.data.plans} onClose={() => setCreating(false)} onDone={() => { setCreating(false); ov.reload(); }} />}
      {ov.data && <TenantSheet tenant={tenant} data={ov.data} onClose={() => setSelected(null)} onChanged={ov.reload} />}
    </>
  );
}

function CreateTenant({ open, plans, onClose, onDone }: { open: boolean; plans: { code: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', slug: '', planCode: 'solo', ownerName: '', ownerEmail: '', ownerPassword: '', justification: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await post('/api/master/tenants', f); toast('Clínica criada.'); onDone(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <Sheet open={open} title="Nova clínica" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <TextInput label="Nome da clínica" value={f.name} onChange={set('name')} />
        <TextInput label="Identificador (usado no login)" value={f.slug} onChange={(v) => set('slug')(v.toLowerCase())} hint="Letras minúsculas, números e hífen." />
        <Select label="Plano comercial" value={f.planCode} onChange={set('planCode')}>{plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select>
        <TextInput label="Nome do proprietário" value={f.ownerName} onChange={set('ownerName')} />
        <TextInput label="E-mail do proprietário" type="email" value={f.ownerEmail} onChange={set('ownerEmail')} inputMode="email" />
        <TextInput label="Senha provisória" type="password" value={f.ownerPassword} onChange={set('ownerPassword')} autoComplete="new-password" hint="Mínimo de 10 caracteres." />
        <TextInput label="Justificativa (auditoria)" value={f.justification} onChange={set('justification')} hint="Exemplo: novo contrato piloto." />
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" busy={busy} className="btn-block">Criar clínica</Button>
      </form>
    </Sheet>
  );
}

function TenantSheet({ tenant, data, onClose, onChanged }: { tenant: Tenant | null; data: Overview; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [why, setWhy] = useState('');
  const [plan, setPlan] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setWhy(''); setCode(''); setError(null); setPlan(tenant?.planCode ?? ''); }, [tenant?.id]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(null);
    try { await fn(); toast(ok); setCode(''); onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (!tenant) return <Sheet open={false} title="" onClose={onClose}>{null}</Sheet>;
  const justified = why.trim().length >= 5;
  const nextStatus = tenant.status === 'active' ? 'suspended' : 'active';

  return (
    <Sheet open title={tenant.name} onClose={onClose}>
      <p className="muted small">Identificador: {tenant.slug} · criada em {dateTimeOf(tenant.createdAt)}</p>
      <TextInput label="Justificativa para as ações abaixo" value={why} onChange={setWhy} hint="Obrigatória e registrada na auditoria (mín. 5 caracteres)." />
      {error && <p className="field-msg error" role="alert">{error}</p>}

      <h3>Plano comercial</h3>
      <div className="row">
        <div className="grow"><Select label="Plano" value={plan} onChange={setPlan}>{data.plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select></div>
        <Button busy={busy} disabled={!justified || plan === tenant.planCode} onClick={() => act(() => patch(`/api/master/tenants/${tenant.id}`, { planCode: plan, justification: why }), 'Plano alterado.')}>Alterar plano</Button>
      </div>

      {tenant.status !== 'closed' && (
        <>
          <h3>Situação: <Badge tone={STATUS_TONE[tenant.status]}>{STATUS_TEXT[tenant.status]}</Badge></h3>
          <div className="row">
            <div className="grow"><TextInput label="Código MFA atual (ação crítica)" value={code} onChange={setCode} inputMode="numeric" maxLength={6} /></div>
            <Button variant={nextStatus === 'suspended' ? 'danger' : 'primary'} busy={busy} disabled={!justified || code.length !== 6}
              onClick={() => act(() => patch(`/api/master/tenants/${tenant.id}`, { status: nextStatus, code, justification: why }), nextStatus === 'suspended' ? 'Clínica suspensa.' : 'Clínica reativada.')}>
              {nextStatus === 'suspended' ? 'Suspender clínica' : 'Reativar clínica'}
            </Button>
          </div>
        </>
      )}

      <h3>Funcionalidades</h3>
      <ul className="list">
        {data.capabilities.map((c) => {
          const o = tenant.overrides.find((x) => x.capability === c.code);
          const on = tenant.effective.includes(c.code);
          return (
            <li key={c.code} className="list-item stack">
              <div className="row between">
                <div><strong>{c.code}</strong><br /><span className="small muted">{c.description}</span></div>
                {!c.globallyAvailable ? <Badge tone="bad">Indisponível</Badge> : on ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}
              </div>
              {o && <span className="small">Ajuste do suporte: <strong>{o.mode === 'grant' ? 'concedida' : 'bloqueada'}</strong> — {o.reason}</span>}
              {c.globallyAvailable && (
                <div className="row">
                  {!on && <Button variant="secondary" className="btn-sm" disabled={!justified || busy} onClick={() => act(() => post(`/api/master/tenants/${tenant.id}/overrides`, { capability: c.code, mode: 'grant', reason: why }), 'Funcionalidade concedida.')}>Conceder</Button>}
                  {on && <Button variant="secondary" className="btn-sm" disabled={!justified || busy} onClick={() => act(() => post(`/api/master/tenants/${tenant.id}/overrides`, { capability: c.code, mode: 'block', reason: why }), 'Funcionalidade bloqueada.')}>Bloquear</Button>}
                  {o && <Button variant="ghost" className="btn-sm" disabled={!justified || busy} onClick={() => act(() => post(`/api/master/tenants/${tenant.id}/overrides`, { capability: c.code, mode: 'clear', reason: why }), 'Ajuste removido.')}>Remover ajuste</Button>}
                </div>
              )}
              {!c.globallyAvailable && <span className="small muted">Convênios/TISS estão bloqueados globalmente nesta fase e não podem ser habilitados.</span>}
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

function Plans() {
  const ov = useLoad(() => get<Overview>('/api/master/overview'), []);
  if (ov.loading && !ov.data) return <Spinner />;
  if (ov.error || !ov.data) return <ErrorBox message={ov.error ?? 'Erro'} onRetry={ov.reload} />;
  return (
    <>
      <div className="page-head"><h1>Planos e funcionalidades</h1></div>
      <p className="muted">Catálogo de referência. Preços e quotas ainda não foram definidos pelo proprietário do produto.</p>
      <ul className="list">
        {ov.data.capabilities.map((c) => (
          <li key={c.code} className="list-item">
            <div className="row between"><strong>{c.code}</strong>{!c.globallyAvailable && <Badge tone="bad">Bloqueada globalmente</Badge>}</div>
            <span className="muted small">{c.description}{c.dependsOn.length ? ` · depende de: ${c.dependsOn.join(', ')}` : ''}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function PlatformAudit() {
  const a = useLoad(() => get<{ events: { id: string; occurredAt: string; operator: string; action: string; justification: string }[] }>('/api/master/audit'), []);
  if (a.loading && !a.data) return <Spinner />;
  if (a.error) return <ErrorBox message={a.error} onRetry={a.reload} />;
  return (
    <>
      <div className="page-head"><h1>Auditoria da plataforma</h1></div>
      <ul className="list">
        {a.data?.events.map((e) => (
          <li key={e.id} className="list-item"><strong>{e.action}</strong><br /><span className="muted small">{e.operator} · {dateTimeOf(e.occurredAt)} · {e.justification}</span></li>
        ))}
      </ul>
    </>
  );
}
