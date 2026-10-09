import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { get, patch, post } from '../api';
import { dateTimeOf } from '../format';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';
import { useMasterMfa } from '../useMfa';
import { Login } from './Login';
import { MasterBilling, MasterSupport } from './MasterBilling';
import { MasterOperators } from './MasterOperators';

interface Capability { code: string; description: string; globallyAvailable: boolean; dependsOn: string[] }
interface Tenant { owner: { name: string; email: string; mfaEnabled: boolean } | null; id: string; slug: string; name: string; status: string; planCode: string; createdAt: string; overrides: { capability: string; mode: 'grant' | 'block'; reason: string }[]; effective: string[] }
interface Overview { plans: { code: string; name: string }[]; capabilities: Capability[]; tenants: Tenant[] }
const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = { active: 'ok', suspended: 'warn', closed: 'bad', provisioning: 'neutral' };
const STATUS_TEXT: Record<string, string> = { active: 'Ativa', suspended: 'Suspensa', closed: 'Encerrada', provisioning: 'Em provisionamento' };

interface Operator { id: string; name: string; email: string; role: string; permissions: string[]; roleLabel: string }

export function MasterApp({ hash }: { hash: string }) {
  const [op, setOp] = useState<Operator | null | undefined>(undefined);
  const refresh = useCallback(() => { get<{ operator: Operator; permissions: string[]; roleLabel: string }>('/api/master/me').then((r) => setOp({ ...r.operator, permissions: r.permissions, roleLabel: r.roleLabel }), () => setOp(null)); }, []);
  useEffect(() => {
    refresh();
    const expired = () => setOp(null);
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, [refresh]);

  if (op === undefined) return <main className="auth"><p className="loading" role="status">Carregando…</p></main>;
  if (op === null) return <Login mode="master" onDone={refresh} />;

  const section = hash.startsWith('/master/funcionalidades') ? 'caps' : hash.startsWith('/master/auditoria') ? 'audit' : hash.startsWith('/master/integracoes') ? 'integrations' : hash.startsWith('/master/cobranca') ? 'billing' : hash.startsWith('/master/suporte') ? 'support' : hash.startsWith('/master/operadores') ? 'operators' : 'tenants';
  const can = (p: string) => op.permissions.includes(p);
  const links = [
    { to: '/master', key: 'tenants', label: 'Clínicas', ico: '▣', show: can('overview.read') },
    { to: '/master/funcionalidades', key: 'caps', label: 'Planos', ico: '◧', show: can('overview.read') },
    { to: '/master/cobranca', key: 'billing', label: 'Cobrança', ico: '$', show: can('billing.read') },
    { to: '/master/suporte', key: 'support', label: 'Suporte', ico: '?', show: can('support.open') },
    { to: '/master/integracoes', key: 'integrations', label: 'Integrações', ico: '⇄', show: can('integrations.read') },
    { to: '/master/auditoria', key: 'audit', label: 'Auditoria', ico: '☰', show: can('audit.read') },
    { to: '/master/operadores', key: 'operators', label: 'Operadores', ico: '☺', show: can('operators.manage') },
  ].filter((l) => l.show);
  return (
    <div className="shell master-mode">
      <header className="topbar">
        <span className="title">Clínica One<span className="pill-master">PLATAFORMA</span></span>
        <Button variant="ghost" className="btn-sm" onClick={async () => { try { await post('/api/master/logout'); } finally { setOp(null); } }}>Sair</Button>
      </header>
      <nav className="nav" aria-label="Plataforma">
        {links.map((l) => <a key={l.key} href={`#${l.to}`} aria-current={section === l.key ? 'page' : undefined}><span className="ico" aria-hidden="true">{l.ico}</span><span className="lbl">{l.label}</span></a>)}
      </nav>
      <main className="content">
        <p className="small muted">{op.name} · {op.roleLabel}</p>
        {section === 'tenants' && <Tenants canManage={can('clinics.manage')} />}
        {section === 'operators' && can('operators.manage') && <MasterOperators meId={op.id} />}
        {section === 'caps' && <Plans />}
        {section === 'billing' && <MasterBilling canManage={can('billing.manage')} />}
        {section === 'support' && <MasterSupport />}
        {section === 'integrations' && <Integrations />}
        {section === 'audit' && <PlatformAudit />}
      </main>
    </div>
  );
}

function Tenants({ canManage }: { canManage: boolean }) {
  const ov = useLoad(() => get<Overview>('/api/master/overview'), []);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const tenant = ov.data?.tenants.find((t) => t.id === selected) ?? null;
  return (
    <>
      <div className="page-head"><h1>Clínicas</h1>{canManage && <Button onClick={() => setCreating(true)}>Nova clínica</Button>}</div>
      {ov.loading && !ov.data && <Spinner />}
      {ov.error && <ErrorBox message={ov.error} onRetry={ov.reload} />}
      {ov.data?.tenants.length === 0 && <Empty title="Nenhuma clínica">Crie a primeira clínica cliente.</Empty>}
      <ul className="list">
        {ov.data?.tenants.map((t) => (
          <li key={t.id}>
            <button className="list-item link btn-block" onClick={() => canManage && setSelected(t.id)}>
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
  const mfa = useMasterMfa();
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
            {mfa && <div className="grow"><TextInput label="Código MFA atual (ação crítica)" value={code} onChange={setCode} inputMode="numeric" maxLength={6} /></div>}
            <Button variant={nextStatus === 'suspended' ? 'danger' : 'primary'} busy={busy} disabled={!justified || (mfa && code.length !== 6)}
              onClick={() => act(() => patch(`/api/master/tenants/${tenant.id}`, { status: nextStatus, code, justification: why }), nextStatus === 'suspended' ? 'Clínica suspensa.' : 'Clínica reativada.')}>
              {nextStatus === 'suspended' ? 'Suspender clínica' : 'Reativar clínica'}
            </Button>
          </div>
        </>
      )}

      {tenant.owner && (
        <>
          <h3>Proprietário</h3>
          <p className="small">{tenant.owner.name} · {tenant.owner.email} {tenant.owner.mfaEnabled ? <Badge tone="info">2 etapas ativa</Badge> : <Badge>2 etapas desativada</Badge>}</p>
          {tenant.owner.mfaEnabled && (
            <>
              <p className="small muted">Se o proprietário perdeu o aparelho, redefina a verificação. Ele será desconectado. Requer justificativa{mfa ? ' e um código MFA seu (informe acima)' : ''}.</p>
              <Button variant="secondary" busy={busy} disabled={!justified || (mfa && code.length !== 6)}
                onClick={() => act(() => post(`/api/master/tenants/${tenant.id}/reset-owner-mfa`, { code, justification: why }), 'Verificação do proprietário redefinida.')}>Redefinir 2 etapas do proprietário</Button>
            </>
          )}
        </>
      )}

      <TenantIntegrations tenantId={tenant.id} why={why} justified={justified} />

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

interface IntegrationsData {
  providers: { kind: string; label: string; provider: string; scope: 'platform' | 'clinic'; env: string[]; pending: string; configured: boolean; perClinic: boolean; implemented: boolean; portReady: boolean; sandbox: boolean; validatedWithProvider: boolean }[];
  queue: { status: string; count: number }[];
  deadByTenant: { tenantId: string; name: string; dead: number }[];
  receipts: { status: string; count: number }[];
  connections: { tenantId: string; kind: string; provider: string; mode: string }[];
}
const KIND_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', email: 'E-mail', sms: 'SMS', payments: 'Pagamentos online', storage: 'Armazenamento de arquivos', calendar: 'Calendários', nfse: 'NFS-e', signature: 'Assinatura eletrônica' };
const QUEUE_LABEL: Record<string, string> = { pending: 'Na fila', processing: 'Processando', sent: 'Enviadas', failed: 'Com nova tentativa', dead: 'Falharam (dead-letter)', skipped: 'Não enviadas (regra)' };

interface AlertsData { transport: string; live: boolean; env: string | null; mutedUntil: number | null; recent: { at: string; severity: string; component: string; title: string; tenant?: string; route?: string; result: string }[] }
const ALERT_RESULT: Record<string, string> = { sent: 'enviado', deduped: 'repetido (agrupado)', muted: 'silenciado', flood: 'limite de volume', failed: 'FALHOU ao enviar', disabled: 'canal desligado' };

function AlertsCard() {
  const toast = useToast();
  const a = useLoad(() => get<AlertsData>('/api/master/alerts'), []);
  const [busy, setBusy] = useState<string | null>(null);
  async function test(kind: 'simple' | 'error') {
    setBusy(kind);
    try {
      const r = await post<{ result: string; transport: string }>('/api/master/alerts/test', { kind });
      toast(r.result === 'sent' ? (r.transport === 'telegram' ? 'Alerta enviado: confira o Telegram.' : 'Enviado ao modo de demonstração (nada saiu do servidor).') : `Não foi enviado: ${ALERT_RESULT[r.result] ?? r.result}.`);
      a.reload();
    } catch (err) { toast((err as Error).message); } finally { setBusy(null); }
  }
  return (
    <div className="card">
      <div className="row between"><h2>Alertas de erro (Telegram)</h2>
        {a.data && (a.data.live ? <Badge tone="ok">Ligado</Badge> : <Badge tone="warn">{a.data.transport === 'sandbox' ? 'Demonstração' : 'Desligado'}</Badge>)}</div>
      {a.error && <ErrorBox message={a.error} onRetry={a.reload} />}
      <p className="small muted">Erros do sistema chegam no Telegram com o componente, a clínica, a rota e o local no código. Os comandos do bot (/status, /erros, /fila…) estão em docs/ALERTAS.md.</p>
      <div className="row">
        <Button busy={busy === 'simple'} onClick={() => test('simple')}>Enviar alerta de teste</Button>
        <Button variant="secondary" busy={busy === 'error'} onClick={() => test('error')}>Simular um erro</Button>
      </div>
      {a.data && a.data.recent.length > 0 && (
        <>
          <h3>Últimos avisos deste servidor</h3>
          <ul className="list">
            {a.data.recent.map((r, i) => (
              <li key={i} className="list-item"><strong>{r.title}</strong><br /><span className="small muted">{dateTimeOf(r.at)} · {r.component}{r.tenant ? ` · ${r.tenant}` : ''}{r.route ? ` · ${r.route}` : ''} · {ALERT_RESULT[r.result] ?? r.result}</span></li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Integrations() {
  const toast = useToast();
  const mfa = useMasterMfa();
  const d = useLoad(() => get<IntegrationsData>('/api/master/integrations'), []);
  const [requeue, setRequeue] = useState<{ tenantId: string; name: string } | null>(null);
  const [why, setWhy] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!requeue) return;
    setBusy(true); setError(null);
    try {
      const r = await post<{ messages: number; receipts: number }>('/api/master/integrations/requeue', { tenantId: requeue.tenantId, code, justification: why });
      toast(`${r.messages} mensagem(ns) e ${r.receipts} recibo(s) recolocados na fila.`); setRequeue(null); setWhy(''); setCode(''); d.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  if (d.loading && !d.data) return <Spinner />;
  if (d.error || !d.data) return <ErrorBox message={d.error ?? 'Erro'} onRetry={d.reload} />;
  return (
    <>
      <div className="page-head"><h1>Integrações</h1></div>
      <p className="muted">Estado dos provedores no servidor. As credenciais ficam em variáveis de ambiente e nunca aparecem aqui. Sem credenciais, o envio acontece em modo de demonstração (simulado).</p>
      <AlertsCard />
      <ul className="list">
        {d.data.providers.map((p) => (
          <li key={p.kind} className="list-item stack">
            <div className="row between"><strong>{p.label ?? KIND_LABEL[p.kind] ?? p.kind}</strong>
              {p.configured ? <Badge tone="ok">Configurado</Badge> : p.perClinic ? <Badge tone="info">Credencial por clínica</Badge> : p.implemented ? <Badge tone="warn">Aguardando credenciais</Badge> : <Badge>Não implementado</Badge>}</div>
            <span className="small muted">Provedor: {p.provider} · credencial {p.scope === 'clinic' ? 'de cada clínica (cifrada no banco)' : 'do servidor (variável de ambiente)'}</span>
            <span className="small muted">Pronto: {p.portReady ? 'porta' : 'sem porta'} · {p.sandbox ? 'sandbox' : 'sem sandbox'} · {p.implemented ? (p.validatedWithProvider ? 'adaptador real validado' : 'adaptador real escrito, NÃO validado com o provedor') : 'adaptador real ainda não escrito'}</span>
            {p.env.length > 0 && <span className="small muted">Variáveis: {p.env.join(', ')}</span>}
            <span className="small">Falta: {p.pending}</span>
          </li>
        ))}
      </ul>
      <h2>Fila de mensagens</h2>
      <div className="stats">
        {d.data.queue.length === 0 && <p className="muted">Fila vazia.</p>}
        {d.data.queue.map((q) => <div key={q.status} className="stat"><b>{q.count}</b><span>{QUEUE_LABEL[q.status] ?? q.status}</span></div>)}
      </div>
      <p className="small muted">Recibos de webhook: {d.data.receipts.length ? d.data.receipts.map((r) => `${r.count} ${r.status}`).join(' · ') : 'nenhum'}.</p>
      <h2>Falhas definitivas por clínica</h2>
      {d.data.deadByTenant.length === 0 && <Empty title="Nenhuma falha definitiva" />}
      <ul className="list">
        {d.data.deadByTenant.map((t) => (
          <li key={t.tenantId} className="list-item row between">
            <span><strong>{t.name}</strong><br /><span className="small muted">{t.dead} mensagem(ns)</span></span>
            <Button variant="secondary" className="btn-sm" onClick={() => setRequeue({ tenantId: t.tenantId, name: t.name })}>Recolocar na fila</Button>
          </li>
        ))}
      </ul>
      <Sheet open={!!requeue} title="Recolocar na fila" onClose={() => setRequeue(null)}>
        <form onSubmit={submit} noValidate>
          <p>As mensagens com falha definitiva de <strong>{requeue?.name}</strong> serão tentadas de novo. O conteúdo das mensagens não é exibido à plataforma.</p>
          <TextInput label="Justificativa (auditoria)" value={why} onChange={setWhy} hint="Exemplo: provedor corrigido." />
          {mfa && <TextInput label="Código MFA atual" value={code} onChange={setCode} inputMode="numeric" maxLength={6} />}
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy} disabled={why.trim().length < 5 || (mfa && code.length !== 6)} className="btn-block">Recolocar na fila</Button>
        </form>
      </Sheet>
    </>
  );
}

function TenantIntegrations({ tenantId, why, justified }: { tenantId: string; why: string; justified: boolean }) {
  const toast = useToast();
  const d = useLoad(() => get<IntegrationsData>('/api/master/integrations'), [tenantId]);
  const [error, setError] = useState<string | null>(null);
  async function setMode(kind: string, mode: string) {
    setError(null);
    try { await post(`/api/master/tenants/${tenantId}/integrations`, { kind, mode, justification: why }); toast('Modo atualizado.'); d.reload(); }
    catch (e) { setError((e as Error).message); }
  }
  const cur = (kind: string) => d.data?.connections.find((c) => c.tenantId === tenantId && c.kind === kind)?.mode;
  return (
    <>
      <h3>Canais de mensagem</h3>
      <p className="small muted">Padrão: demonstração (simulado). "Produção" exige credenciais configuradas no servidor.</p>
      {error && <p className="field-msg error" role="alert">{error}</p>}
      <ul className="list">
        {['whatsapp', 'email', 'sms'].map((k) => (
          <li key={k} className="list-item stack">
            <div className="row between"><strong>{KIND_LABEL[k]}</strong><Badge tone={cur(k) === 'live' ? 'ok' : cur(k) === 'disabled' ? 'bad' : 'neutral'}>{cur(k) === 'live' ? 'Produção' : cur(k) === 'disabled' ? 'Desativado' : 'Demonstração'}</Badge></div>
            <div className="row">
              {(['sandbox', 'live', 'disabled'] as const).filter((m) => m !== (cur(k) ?? 'sandbox')).map((m) => (
                <Button key={m} variant="secondary" className="btn-sm" disabled={!justified} onClick={() => setMode(k, m)}>{m === 'sandbox' ? 'Usar demonstração' : m === 'live' ? 'Usar produção' : 'Desativar'}</Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
