import { useState } from 'react';
import { get, post } from '../api';
import { dateTimeOf } from '../format';
import { Badge, Button, Empty, ErrorBox, Sheet, Spinner, useLoad, useToast } from '../ui';

/** Cartão na ficha do paciente: gerar o link de acesso ao portal e revogar acessos. */
export function PortalCard({ patientId }: { patientId: string }) {
  const toast = useToast();
  const st = useLoad(() => get<{ hasBirthDate: boolean; hasActiveSession: boolean; hasOpenInvite: boolean; lastAccessAt: string | null }>(`/api/patients/${patientId}/portal-status`), [patientId]);
  const [link, setLink] = useState<{ link: string; expiresAt: string; hours: number } | null>(null);
  const [busy, setBusy] = useState(false);

  async function invite() {
    setBusy(true);
    try { setLink(await post(`/api/patients/${patientId}/portal-invite`)); st.reload(); } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  }
  async function revoke() {
    if (!window.confirm('Revogar o acesso do paciente ao portal? Links e sessões abertas deixam de valer.')) return;
    setBusy(true);
    try { await post(`/api/patients/${patientId}/portal-revoke`); toast('Acesso ao portal revogado.'); st.reload(); } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  }
  async function copy() { try { await navigator.clipboard.writeText(link!.link); toast('Link copiado.'); } catch { toast('Copie o link manualmente.', 'bad'); } }

  return (
    <section className="card" aria-labelledby="portal-title">
      <div className="row between"><h2 id="portal-title">Portal do paciente</h2>{st.data?.hasActiveSession && <Badge tone="ok">Acessou recentemente</Badge>}</div>
      {st.loading && !st.data && <Spinner />}
      {st.error && <ErrorBox message={st.error} onRetry={st.reload} />}
      {st.data && !st.data.hasBirthDate && <p className="small">Cadastre a data de nascimento do paciente para liberar o portal: ela confirma a identidade no primeiro acesso.</p>}
      {st.data && st.data.hasBirthDate && (
        <>
          <p className="small muted">O paciente vê as próprias consultas, confirma ou cancela, pede horários e baixa os documentos que você liberar. O link vale por uso único.</p>
          <div className="row">
            <Button className="btn-sm" busy={busy} onClick={invite}>{st.data.hasOpenInvite ? 'Gerar novo link' : 'Gerar link de acesso'}</Button>
            {(st.data.hasActiveSession || st.data.hasOpenInvite) && <Button variant="danger" className="btn-sm" busy={busy} onClick={revoke}>Revogar acessos</Button>}
          </div>
        </>
      )}
      <Sheet open={link !== null} title="Link de acesso ao portal" onClose={() => setLink(null)}>
        {link && (
          <div className="stack">
            <p>Envie este link ao paciente (por exemplo, pelo WhatsApp). Ele vale por {link.hours} horas e só funciona uma vez; no primeiro acesso o paciente informa a data de nascimento.</p>
            <input readOnly value={link.link} aria-label="Link de acesso" onFocus={(e) => e.currentTarget.select()} />
            <p className="small muted">Vence em {dateTimeOf(link.expiresAt)}. Este link não será exibido de novo: gere outro se precisar.</p>
            <div className="row"><Button onClick={copy}>Copiar link</Button><Button variant="ghost" onClick={() => setLink(null)}>Fechar</Button></div>
          </div>
        )}
      </Sheet>
    </section>
  );
}

interface PRequest { id: string; kind: 'schedule' | 'reschedule' | 'cancel'; message: string | null; createdAt: string; patientId: string; patientName: string; startsAt: string | null; service: string | null; professionalName: string | null }
const KIND = { schedule: 'Quer marcar consulta', reschedule: 'Quer remarcar', cancel: 'Pede cancelamento' } as const;

/** Pedidos feitos pelos pacientes no portal (novo horário, remarcação, cancelamento em cima da hora). */
export function PortalRequests() {
  const toast = useToast();
  const list = useLoad(() => get<{ requests: PRequest[] }>('/api/portal-requests'), []);
  const [busy, setBusy] = useState<string | null>(null);
  async function resolve(r: PRequest, action: 'done' | 'dismissed') {
    const msg = action === 'done' && r.kind === 'cancel' ? 'Cancelar a consulta do paciente?' : action === 'dismissed' ? 'Recusar este pedido?' : null;
    if (msg && !window.confirm(msg)) return;
    setBusy(r.id);
    try { await post(`/api/portal-requests/${r.id}/resolve`, { action }); toast(action === 'done' ? 'Pedido atendido.' : 'Pedido recusado.'); list.reload(); } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(null); }
  }
  if (list.loading && !list.data) return null;
  if (list.error || !list.data || list.data.requests.length === 0) return null;
  return (
    <section aria-labelledby="pr-title" className="stack">
      <h2 id="pr-title">Pedidos do portal ({list.data.requests.length})</h2>
      <ul className="list">
        {list.data.requests.map((r) => (
          <li key={r.id} className="list-item stack">
            <div className="row between"><a href={`#/pacientes/${r.patientId}`}><strong>{r.patientName}</strong></a><Badge tone="warn">{KIND[r.kind]}</Badge></div>
            {r.startsAt && <span className="small muted">Consulta de {dateTimeOf(r.startsAt)} · {r.service} · {r.professionalName}</span>}
            {r.message && <span className="small">“{r.message}”</span>}
            <span className="small muted">Pedido em {dateTimeOf(r.createdAt)}</span>
            <div className="row">
              <Button className="btn-sm" busy={busy === r.id} onClick={() => resolve(r, 'done')}>{r.kind === 'cancel' ? 'Cancelar a consulta' : 'Marcar como atendido'}</Button>
              <Button variant="ghost" className="btn-sm" onClick={() => resolve(r, 'dismissed')}>Recusar</Button>
            </div>
          </li>
        ))}
      </ul>
      {!list.data.requests.length && <Empty title="Nenhum pedido">Os pedidos dos pacientes aparecem aqui.</Empty>}
    </section>
  );
}
