import { useState, type FormEvent } from 'react';
import { get, post } from '../api';
import { brl, dateTimeOf } from '../format';
import { Badge, Button, Empty, ErrorBox, Select, Spinner, TextInput, useLoad, useToast } from '../ui';

interface Billing {
  plan: { code: string; name: string; priceCents: number | null; dueDay: number };
  status: { state: 'ok' | 'late' | 'suspend'; daysOverdue: number; graceLeft: number | null };
  usage: { users: number; patients: number; storageMb: number };
  limits: { users: number | null; patients: number | null; storageMb: number | null };
  invoices: { id: string; period: string; amountCents: number; dueDate: string; status: 'open' | 'paid' | 'void'; paidAt: string | null }[];
}
interface Grant { id: string; reason: string; createdAt: string; expiresAt: string; revokedAt: string | null; active: boolean; grantedByName: string }
interface AccessLog { id: string; operator: string; resource: string; occurredAt: string }

const ymd = (s: string) => s.split('-').reverse().join('/');
const monthOf = (s: string) => `${s.slice(5, 7)}/${s.slice(0, 4)}`;
const INV_TONE = { open: 'warn', paid: 'ok', void: 'neutral' } as const;
const INV_TEXT = { open: 'Em aberto', paid: 'Paga', void: 'Anulada' } as const;

function Meter({ label, value, max, unit = '' }: { label: string; value: number; max: number | null; unit?: string }) {
  return (
    <li className="barrow"><span className="small">{label}</span>
      {max !== null ? <meter min={0} max={max} low={max * 0.8} high={max * 0.9} optimum={0} value={Math.min(value, max)} aria-label={`${label}: ${value} de ${max}`} /> : <span />}
      <strong className="small">{value.toLocaleString('pt-BR')}{unit}{max !== null ? ` / ${max.toLocaleString('pt-BR')}${unit}` : ' (sem limite)'}</strong></li>
  );
}

/** Gestão → Assinatura (proprietário): plano, uso, faturas e acesso temporário do suporte. */
export function Subscription() {
  const b = useLoad(() => get<Billing>('/api/billing'), []);
  if (b.loading && !b.data) return <Spinner />;
  if (b.error || !b.data) return <ErrorBox message={b.error ?? 'Erro ao carregar.'} onRetry={b.reload} />;
  const d = b.data;
  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="sub-plan">
        <div className="row between"><h2 id="sub-plan">{d.plan.name}</h2>
          {d.status.state === 'ok' ? <Badge tone="ok">Em dia</Badge> : <Badge tone="bad">Fatura em atraso</Badge>}</div>
        <p className="small">{d.plan.priceCents ? <>Mensalidade: <strong>{brl(d.plan.priceCents)}</strong> · vencimento todo dia {d.plan.dueDay}</> : 'Sem cobrança configurada para esta clínica.'}</p>
        {d.status.state !== 'ok' && <div className="banner" role="note">Há fatura vencida há {d.status.daysOverdue} dia(s). {d.status.graceLeft ? `O acesso será suspenso se não for paga em ${d.status.graceLeft} dia(s).` : 'O acesso pode ser suspenso a qualquer momento.'}</div>}
        <h3>Uso do plano</h3>
        <ul className="list">
          <Meter label="Usuários ativos" value={d.usage.users} max={d.limits.users} />
          <Meter label="Pacientes" value={d.usage.patients} max={d.limits.patients} />
          <Meter label="Arquivos" value={d.usage.storageMb} max={d.limits.storageMb} unit=" MB" />
        </ul>
      </section>
      <section className="card stack" aria-labelledby="sub-inv">
        <h2 id="sub-inv">Faturas</h2>
        {d.invoices.length === 0 && <Empty title="Nenhuma fatura">As faturas aparecem aqui quando a cobrança começar.</Empty>}
        <ul className="list">
          {d.invoices.map((i) => (
            <li key={i.id} className="list-item row between"><span><strong>{monthOf(i.period)}</strong><br /><span className="small muted">vence em {ymd(i.dueDate)}{i.paidAt ? ` · paga em ${dateTimeOf(i.paidAt)}` : ''}</span></span>
              <span className="row"><strong>{brl(i.amountCents)}</strong><Badge tone={INV_TONE[i.status]}>{INV_TEXT[i.status]}</Badge></span></li>
          ))}
        </ul>
        <p className="small muted">O pagamento é combinado diretamente com a plataforma; a baixa é feita por ela.</p>
      </section>
      <SupportAccess />
    </div>
  );
}

function SupportAccess() {
  const toast = useToast();
  const g = useLoad(() => get<{ grants: Grant[]; accessLog: AccessLog[] }>('/api/support-grants'), []);
  const [hours, setHours] = useState('2');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = g.data?.grants.find((x) => x.active);
  async function grant(e: FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try { await post('/api/support-grants', { hours: Number(hours), reason }); toast('Acesso liberado ao suporte.'); setReason(''); g.reload(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    try { await post(`/api/support-grants/${id}/revoke`); toast('Acesso do suporte encerrado.'); g.reload(); } catch (err) { toast((err as Error).message, 'bad'); }
  }
  return (
    <section className="card stack" aria-labelledby="sup-t">
      <h2 id="sup-t">Acesso do suporte</h2>
      <p className="small muted">Por padrão o suporte da plataforma não vê nada da sua clínica. Se precisar de ajuda, libere por um tempo limitado (até 24 h). Durante esse prazo ele vê somente a configuração: equipe, unidades e registro de atividades. <strong>Nunca</strong> pacientes, prontuário, financeiro ou mensagens. Tudo o que ele abrir aparece abaixo.</p>
      {g.loading && !g.data && <Spinner />}
      {g.error && <ErrorBox message={g.error} onRetry={g.reload} />}
      {active ? (
        <div className="banner" role="note">
          Acesso liberado até {dateTimeOf(active.expiresAt)} — {active.reason}
          <div><Button variant="danger" className="btn-sm" onClick={() => revoke(active.id)}>Encerrar agora</Button></div>
        </div>
      ) : (
        <form onSubmit={grant} noValidate>
          <Select label="Liberar por" value={hours} onChange={setHours}>{[1, 2, 4, 8, 24].map((h) => <option key={h} value={h}>{h} hora{h > 1 ? 's' : ''}</option>)}</Select>
          <TextInput label="Motivo" value={reason} onChange={setReason} hint="Ex.: ajuda para configurar a agenda (mín. 5 caracteres)." />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy}>Liberar acesso ao suporte</Button>
        </form>
      )}
      {g.data && g.data.accessLog.length > 0 && (
        <>
          <h3>O que o suporte abriu</h3>
          <ul className="list">{g.data.accessLog.map((l) => <li key={l.id} className="list-item row between"><span>{l.operator}</span><span className="small muted">{l.resource === 'config' ? 'configuração e equipe' : l.resource} · {dateTimeOf(l.occurredAt)}</span></li>)}</ul>
        </>
      )}
    </section>
  );
}
