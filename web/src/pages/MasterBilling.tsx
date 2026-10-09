import { useState, type FormEvent } from 'react';
import { get, patch, post } from '../api';
import { brl, dateTimeOf } from '../format';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';
import { useMasterMfa } from '../useMfa';

interface PlanRow { code: string; name: string; priceCents: number | null; maxUsers: number | null; maxPatients: number | null; maxStorageMb: number | null }
interface TenantRow { id: string; slug: string; name: string; status: string; planCode: string; priceCents: number | null; overrideCents: number | null; dueDay: number; graceDays: number; suspendedByBilling: boolean; openInvoices: number; state: 'ok' | 'late' | 'suspend'; daysOverdue: number }
interface InvoiceRow { id: string; tenantId: string; tenantName: string; period: string; amountCents: number; dueDate: string; status: 'open' | 'paid' | 'void'; paidAt: string | null; paidMethod: string | null; voidReason: string | null }
interface Data { today: string; plans: PlanRow[]; tenants: TenantRow[]; invoices: InvoiceRow[] }

const ymd = (s: string) => s.split('-').reverse().join('/');
const num = (v: string) => (v.trim() === '' ? null : Number(v));
const reaisToCents = (v: string) => (v.trim() === '' ? null : Math.round(Number(v.replace(',', '.')) * 100));
const centsToReais = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2).replace('.', ','));
const METHODS: Record<string, string> = { pix: 'Pix', boleto: 'Boleto', card: 'Cartão', transfer: 'Transferência', other: 'Outro' };

/** Plataforma → Cobrança: preços e limites por plano, combinado por cliente, faturas e inadimplência. */
export function MasterBilling({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const mfa = useMasterMfa();
  const d = useLoad(() => get<Data>('/api/master/billing'), []);
  const [why, setWhy] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<PlanRow | null>(null);
  const [tenant, setTenant] = useState<TenantRow | null>(null);
  const [paying, setPaying] = useState<InvoiceRow | null>(null);
  const justified = why.trim().length >= 5;

  async function act(fn: () => Promise<unknown>, ok: (r: any) => string) {
    setBusy(true);
    try { const r = await fn(); toast(ok(r)); setCode(''); d.reload(); } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="page-head"><h1>Cobrança</h1></div>
      {canManage && <div className="card stack">
        <TextInput label="Justificativa para as ações desta tela" value={why} onChange={setWhy} hint="Obrigatória e registrada na auditoria (mín. 5 caracteres)." />
        {mfa && <TextInput label="Código MFA atual (preços, limites e suspensões)" value={code} onChange={setCode} inputMode="numeric" maxLength={6} />}
        <div className="row">
          <Button variant="secondary" busy={busy} disabled={!justified} onClick={() => act(() => post('/api/master/billing/generate', { justification: why }), (r) => `Faturas do mês: ${r.created} nova(s); ${r.skippedNoPrice} cliente(s) sem preço.`)}>Gerar faturas do mês</Button>
          <Button variant="danger" busy={busy} disabled={!justified || (mfa && code.length !== 6)} onClick={() => act(() => post('/api/master/billing/run', { code, justification: why }), (r) => r.changes.length ? r.changes.map((c: { name: string; action: string }) => `${c.name}: ${c.action === 'suspended' ? 'suspensa' : 'reativada'}`).join('; ') : 'Nenhuma clínica mudou de situação.')}>Avaliar inadimplência</Button>
        </div>
        <p className="small muted">Suspensão por cobrança só vale para quem passou da carência; pagar a fatura reativa sozinho. Rotina automática: variável <code>BILLING_AUTO=1</code>.</p>
      </div>}
      {d.loading && !d.data && <Spinner />}
      {d.error && <ErrorBox message={d.error} onRetry={d.reload} />}
      {d.data && (
        <>
          <section className="card stack" aria-labelledby="mb-plans"><h2 id="mb-plans">Planos: preço e limites</h2>
            <ul className="list">{d.data.plans.map((p) => (
              <li key={p.code} className="list-item row between"><span><strong>{p.name}</strong><br /><span className="small muted">{p.priceCents ? brl(p.priceCents) : 'sem preço'} · usuários {p.maxUsers ?? '∞'} · pacientes {p.maxPatients ?? '∞'} · arquivos {p.maxStorageMb ? `${p.maxStorageMb} MB` : '∞'}</span></span>
                {canManage && <Button variant="secondary" className="btn-sm" onClick={() => setPlan(p)}>Editar</Button>}</li>))}</ul>
          </section>
          <section className="card stack" aria-labelledby="mb-ten"><h2 id="mb-ten">Clientes</h2>
            <ul className="list">{d.data.tenants.map((t) => (
              <li key={t.id} className="list-item stack">
                <div className="row between"><strong>{t.name}</strong>
                  <span className="row">{t.suspendedByBilling && <Badge tone="bad">Suspensa por cobrança</Badge>}{t.state === 'late' && <Badge tone="warn">Atrasada há {t.daysOverdue} d</Badge>}{t.state === 'suspend' && <Badge tone="bad">Passou da carência ({t.daysOverdue} d)</Badge>}{t.state === 'ok' && !t.suspendedByBilling && <Badge tone="ok">Em dia</Badge>}</span></div>
                <span className="small muted">{t.planCode} · {t.priceCents ? `${brl(t.priceCents)}${t.overrideCents !== null ? ' (combinado)' : ''}` : 'sem cobrança'} · vence dia {t.dueDay} · carência {t.graceDays} d · {t.openInvoices} em aberto</span>
                {canManage && <div><Button variant="secondary" className="btn-sm" onClick={() => setTenant(t)}>Combinar valor e vencimento</Button></div>}
              </li>))}</ul>
          </section>
          <section className="card stack" aria-labelledby="mb-inv"><h2 id="mb-inv">Faturas</h2>
            {d.data.invoices.length === 0 && <Empty title="Nenhuma fatura">Defina preços e gere as faturas do mês.</Empty>}
            <ul className="list">{d.data.invoices.map((i) => (
              <li key={i.id} className="list-item row between"><span><strong>{i.tenantName}</strong> · {i.period.slice(5, 7)}/{i.period.slice(0, 4)}<br /><span className="small muted">vence {ymd(i.dueDate)}{i.paidAt ? ` · paga ${dateTimeOf(i.paidAt)} (${METHODS[i.paidMethod ?? ''] ?? ''})` : ''}{i.voidReason ? ` · anulada: ${i.voidReason}` : ''}</span></span>
                <span className="row"><strong>{brl(i.amountCents)}</strong>
                  {i.status === 'open' && canManage ? <><Button className="btn-sm" disabled={!justified} onClick={() => setPaying(i)}>Dar baixa</Button><Button variant="ghost" className="btn-sm" disabled={!justified} onClick={() => { const r = window.prompt('Motivo da anulação:'); if (r && r.trim().length >= 3) void act(() => post(`/api/master/invoices/${i.id}/void`, { reason: r.trim(), justification: why }), () => 'Fatura anulada.'); }}>Anular</Button></> : <Badge tone={i.status === 'paid' ? 'ok' : i.status === 'open' ? 'warn' : 'neutral'}>{i.status === 'paid' ? 'Paga' : i.status === 'open' ? 'Em aberto' : 'Anulada'}</Badge>}</span></li>))}</ul>
          </section>
        </>
      )}
      <PlanSheet plan={plan} why={why} code={code} mfa={mfa} justified={justified} onClose={() => setPlan(null)} onDone={() => { setPlan(null); setCode(''); d.reload(); }} />
      <TenantBillingSheet tenant={tenant} why={why} justified={justified} onClose={() => setTenant(null)} onDone={() => { setTenant(null); d.reload(); }} />
      <PaySheet inv={paying} why={why} onClose={() => setPaying(null)} onDone={() => { setPaying(null); d.reload(); }} />
    </>
  );
}

function PlanSheet({ plan, why, code, mfa, justified, onClose, onDone }: { plan: PlanRow | null; why: string; code: string; mfa: boolean; justified: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ price: '', users: '', patients: '', storage: '' });
  const [seed, setSeed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if ((plan?.code ?? null) !== seed) { setSeed(plan?.code ?? null); if (plan) setF({ price: centsToReais(plan.priceCents), users: plan.maxUsers?.toString() ?? '', patients: plan.maxPatients?.toString() ?? '', storage: plan.maxStorageMb?.toString() ?? '' }); setError(null); }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!plan) return;
    try {
      await patch(`/api/master/plans/${plan.code}`, { priceCents: reaisToCents(f.price), maxUsers: num(f.users), maxPatients: num(f.patients), maxStorageMb: num(f.storage), code, justification: why });
      toast('Plano atualizado.'); onDone();
    } catch (err) { setError((err as Error).message); }
  }
  return (
    <Sheet open={!!plan} title={`Plano ${plan?.name ?? ''}`} onClose={onClose}>
      <form onSubmit={save} noValidate>
        <TextInput label="Mensalidade (R$)" inputMode="decimal" value={f.price} onChange={(v) => setF({ ...f, price: v })} hint="Vazio = sem cobrança." />
        <TextInput label="Máx. de usuários ativos" inputMode="numeric" value={f.users} onChange={(v) => setF({ ...f, users: v })} hint="Vazio = sem limite." />
        <TextInput label="Máx. de pacientes" inputMode="numeric" value={f.patients} onChange={(v) => setF({ ...f, patients: v })} />
        <TextInput label="Máx. de arquivos (MB)" inputMode="numeric" value={f.storage} onChange={(v) => setF({ ...f, storage: v })} />
        <p className="small muted">Limites barram só novos cadastros; o que já existe continua. Use a justificativa e o código MFA da tela anterior.</p>
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" disabled={!justified || (mfa && code.length !== 6)} className="btn-block">Salvar plano</Button>
      </form>
    </Sheet>
  );
}

function TenantBillingSheet({ tenant, why, justified, onClose, onDone }: { tenant: TenantRow | null; why: string; justified: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ price: '', day: '10', grace: '7' });
  const [seed, setSeed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if ((tenant?.id ?? null) !== seed) { setSeed(tenant?.id ?? null); if (tenant) setF({ price: centsToReais(tenant.overrideCents), day: String(tenant.dueDay), grace: String(tenant.graceDays) }); setError(null); }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!tenant) return;
    try { await patch(`/api/master/tenants/${tenant.id}/billing`, { overrideCents: reaisToCents(f.price), dueDay: Number(f.day), graceDays: Number(f.grace), justification: why }); toast('Combinado salvo.'); onDone(); }
    catch (err) { setError((err as Error).message); }
  }
  return (
    <Sheet open={!!tenant} title={tenant?.name ?? ''} onClose={onClose}>
      <form onSubmit={save} noValidate>
        <TextInput label="Valor combinado (R$)" inputMode="decimal" value={f.price} onChange={(v) => setF({ ...f, price: v })} hint="Vazio = vale o preço do plano. 0 = cliente isento." />
        <TextInput label="Dia do vencimento (1 a 28)" inputMode="numeric" value={f.day} onChange={(v) => setF({ ...f, day: v })} />
        <TextInput label="Carência após o vencimento (dias)" inputMode="numeric" value={f.grace} onChange={(v) => setF({ ...f, grace: v })} hint="Passou disso sem pagar, a clínica é suspensa." />
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" disabled={!justified} className="btn-block">Salvar</Button>
      </form>
    </Sheet>
  );
}

function PaySheet({ inv, why, onClose, onDone }: { inv: InvoiceRow | null; why: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [method, setMethod] = useState('pix');
  const [ref, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!inv) return;
    try { await post(`/api/master/invoices/${inv.id}/pay`, { method, reference: ref || undefined, justification: why }); toast('Baixa registrada.'); setRef(''); onDone(); }
    catch (err) { setError((err as Error).message); }
  }
  return (
    <Sheet open={!!inv} title={`Baixa: ${inv?.tenantName ?? ''}`} onClose={onClose}>
      <form onSubmit={save} noValidate>
        <p>{inv ? brl(inv.amountCents) : ''}</p>
        <Select label="Forma de pagamento" value={method} onChange={setMethod}>{Object.entries(METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <TextInput label="Referência (opcional)" value={ref} onChange={setRef} />
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" className="btn-block">Confirmar baixa</Button>
      </form>
    </Sheet>
  );
}

interface Grant { id: string; tenantId: string; tenantName: string; slug: string; reason: string; createdAt: string; expiresAt: string }
interface Opened { tenant: { name: string; slug: string; status: string; planCode: string }; users: { name: string; email: string; role: string; status: string; mfaEnabled: boolean }[]; units: { name: string }[]; audit: { occurredAt: string; action: string; entityType: string }[] }

/** Plataforma → Suporte: clínicas que liberaram acesso; abrir exige MFA e justificativa, e a clínica vê cada abertura. */
export function MasterSupport() {
  const mfa = useMasterMfa();
  const toast = useToast();
  const g = useLoad(() => get<{ grants: Grant[] }>('/api/master/support'), []);
  const [why, setWhy] = useState('');
  const [code, setCode] = useState('');
  const [data, setData] = useState<Opened | null>(null);
  const [busy, setBusy] = useState(false);
  async function open(id: string) {
    setBusy(true);
    try { setData(await post<Opened>(`/api/master/tenants/${id}/support/open`, { code, justification: why })); setCode(''); } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="page-head"><h1>Suporte</h1></div>
      <div className="card stack">
        <p className="small muted">Aparecem só as clínicas que liberaram acesso por tempo limitado. Você vê equipe, unidades e registro de atividades — nunca dados de pacientes. Cada abertura fica no histórico da clínica.</p>
        <TextInput label="Justificativa (ex.: chamado #123)" value={why} onChange={setWhy} />
        {mfa && <TextInput label="Código MFA atual" value={code} onChange={setCode} inputMode="numeric" maxLength={6} />}
      </div>
      {g.loading && !g.data && <Spinner />}
      {g.error && <ErrorBox message={g.error} onRetry={g.reload} />}
      {g.data?.grants.length === 0 && <Empty title="Nenhuma clínica liberou acesso">Quando alguém pedir ajuda, o proprietário libera em Gestão → Assinatura.</Empty>}
      <ul className="list">{g.data?.grants.map((x) => (
        <li key={x.id} className="list-item stack"><div className="row between"><strong>{x.tenantName}</strong><Badge tone="info">até {dateTimeOf(x.expiresAt)}</Badge></div>
          <span className="small muted">{x.reason}</span>
          <div><Button className="btn-sm" busy={busy} disabled={why.trim().length < 5 || (mfa && code.length !== 6)} onClick={() => open(x.tenantId)}>Abrir configuração</Button></div></li>))}</ul>
      <Sheet open={!!data} title={data?.tenant.name ?? ''} onClose={() => setData(null)}>
        {data && (
          <div className="stack">
            <p className="small muted">{data.tenant.slug} · plano {data.tenant.planCode} · {data.tenant.status}</p>
            <h3>Equipe</h3><ul className="list">{data.users.map((u) => <li key={u.email} className="list-item"><strong>{u.name}</strong> <span className="small muted">{u.email} · {u.role} · {u.status}{u.mfaEnabled ? ' · 2 etapas' : ''}</span></li>)}</ul>
            <h3>Unidades</h3><p className="small">{data.units.map((u) => u.name).join(', ') || '—'}</p>
            <h3>Últimas atividades</h3><ul className="list">{data.audit.map((a, i) => <li key={i} className="list-item small">{a.action} <span className="muted">· {dateTimeOf(a.occurredAt)}</span></li>)}</ul>
          </div>
        )}
      </Sheet>
    </>
  );
}
