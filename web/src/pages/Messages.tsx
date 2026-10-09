import { get, post } from '../api';
import { dateTimeOf } from '../format';
import { Badge, Button, Empty, ErrorBox, Spinner, useLoad, usePolling, useToast } from '../ui';

interface Consent { purpose: string; granted: boolean; createdAt: string; recordedBy: string | null }
const PURPOSES: { key: string; label: string }[] = [
  { key: 'communication_whatsapp', label: 'WhatsApp' }, { key: 'communication_email', label: 'E-mail' }, { key: 'communication_sms', label: 'SMS' },
];

/** Autorização do paciente para receber mensagens. Sem autorização vigente, nenhuma mensagem é enviada. */
export function Consents({ patientId, canWrite }: { patientId: string; canWrite: boolean }) {
  const toast = useToast();
  const c = useLoad(() => get<{ consents: Consent[] }>(`/api/patients/${patientId}/consents`), [patientId]);
  async function set(purpose: string, granted: boolean) {
    try { await post(`/api/patients/${patientId}/consents`, { purpose, granted }); toast(granted ? 'Autorização registrada.' : 'Autorização revogada.'); c.reload(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  }
  return (
    <section className="card" aria-labelledby="consent-title">
      <h2 id="consent-title">Comunicação com o paciente</h2>
      <p className="small muted">Mensagens só são enviadas com a autorização do paciente. Cada mudança fica registrada, e o histórico é mantido.</p>
      {c.loading && !c.data && <Spinner />}
      {c.error && <ErrorBox message={c.error} onRetry={c.reload} />}
      {c.data && <ul className="list">
        {PURPOSES.map((p) => {
          const cur = c.data?.consents.find((x) => x.purpose === p.key);
          return (
            <li key={p.key} className="list-item stack">
              <div className="row between"><strong>{p.label}</strong>{cur?.granted ? <Badge tone="ok">Autorizado</Badge> : <Badge>Sem autorização</Badge>}</div>
              {cur && <span className="small muted">{cur.granted ? 'Autorizado' : 'Revogado'} em {dateTimeOf(cur.createdAt)}{cur.recordedBy ? ` por ${cur.recordedBy}` : ''}</span>}
              {canWrite && (cur?.granted
                ? <Button variant="secondary" className="btn-sm" onClick={() => set(p.key, false)}>Revogar autorização</Button>
                : <Button variant="secondary" className="btn-sm" onClick={() => set(p.key, true)}>Registrar autorização</Button>)}
            </li>
          );
        })}
      </ul>}
    </section>
  );
}

interface Msg { id: string; template: string; channel: string | null; status: string; deliveryStatus: string | null; reason: string | null; scheduledFor: string; createdAt: string }
const TEMPLATE: Record<string, string> = { appointment_confirmation: 'Confirmação de consulta', appointment_reminder: 'Lembrete de consulta', appointment_cancelled: 'Aviso de cancelamento', appointment_rescheduled: 'Aviso de remarcação' };
const CHANNEL: Record<string, string> = { whatsapp: 'WhatsApp', email: 'E-mail', sms: 'SMS' };
const SKIP: Record<string, string> = { no_consent: 'sem autorização do paciente', no_contact: 'paciente sem contato cadastrado', integration_disabled: 'canal desativado pela plataforma', appointment_changed: 'a consulta foi alterada ou cancelada' };

function state(m: Msg): { tone: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; text: string } {
  if (m.status === 'sent') return m.deliveryStatus === 'read' ? { tone: 'ok', text: 'Lida' } : m.deliveryStatus === 'delivered' ? { tone: 'ok', text: 'Entregue' } : m.deliveryStatus === 'failed' ? { tone: 'bad', text: 'Não entregue' } : { tone: 'info', text: 'Enviada' };
  if (m.status === 'skipped') return { tone: 'neutral', text: `Não enviada: ${SKIP[m.reason ?? ''] ?? 'motivo registrado'}` };
  if (m.status === 'failed') return { tone: 'warn', text: 'Nova tentativa agendada' };
  if (m.status === 'dead') return { tone: 'bad', text: 'Falhou; a plataforma foi notificada' };
  return new Date(m.scheduledFor).getTime() > Date.now() + 60_000 ? { tone: 'neutral', text: `Agendada para ${dateTimeOf(m.scheduledFor)}` } : { tone: 'neutral', text: 'Na fila de envio' };
}

export function MessageHistory({ patientId }: { patientId: string }) {
  const m = useLoad(() => get<{ messages: Msg[] }>(`/api/patients/${patientId}/messages`), [patientId]);
  // Enquanto houver mensagem em andamento (na fila, processando ou com nova tentativa), atualiza sozinho.
  const inFlight = !!m.data?.messages.some((x) => x.status === 'processing' || x.status === 'failed' || (x.status === 'pending' && new Date(x.scheduledFor).getTime() <= Date.now() + 60_000));
  usePolling(m.reload, 4000, inFlight);
  if (m.loading && !m.data) return <Spinner />;
  if (m.error || !m.data) return <ErrorBox message={m.error ?? 'Erro'} onRetry={m.reload} />;
  return (
    <div className="stack">
      <p className="small muted">Confirmações, lembretes e avisos de consulta. Em ambiente de demonstração o envio é simulado.</p>
      {m.data.messages.length === 0 && <Empty title="Nenhuma mensagem ainda">Elas aparecem quando uma consulta é agendada, remarcada ou cancelada.</Empty>}
      <ul className="list">
        {m.data.messages.map((x) => {
          const s = state(x);
          return (
            <li key={x.id} className="list-item stack">
              <div className="row between"><strong>{TEMPLATE[x.template] ?? x.template}</strong><Badge tone={s.tone}>{s.text}</Badge></div>
              <span className="small muted">{x.channel ? CHANNEL[x.channel] : 'Sem canal'} · {dateTimeOf(x.createdAt)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
