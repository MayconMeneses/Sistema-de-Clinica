import { useState } from 'react';
import { get, patch } from '../api';
import { STATUS_LABEL, timeOf } from '../format';
import { TriageSheet } from './FormsStaff';
import { PortalRequests } from './PortalStaff';
import { Badge, Button, Empty, ErrorBox, Spinner, useLoad, usePolling, useToast } from '../ui';

interface Appt { id: string; status: string; priority: string; startsAt: string; checkedInAt: string | null; patientId: string; patientName: string; professionalName: string; resourceName: string | null; service: string; triageDone?: boolean; formsPending?: number; formsSubmitted?: number }

/** Fila do dia: quem ainda vai chegar, quem espera, quem está sendo atendido. Atualiza sozinha a cada 15 s. */
export function Reception({ canWrite, portal = false, forms = false, canTriage = false }: { canWrite: boolean; portal?: boolean; forms?: boolean; canTriage?: boolean }) {
  const toast = useToast();
  const list = useLoad(() => get<{ appointments: Appt[] }>('/api/reception'), []);
  const [triaging, setTriaging] = useState<Appt | null>(null);
  const [, tick] = useState(0);
  usePolling(() => { list.reload(); tick((n) => n + 1); }, 15000);

  async function move(a: Appt, body: object, ok: string) {
    try { await patch(`/api/appointments/${a.id}`, body); toast(ok); list.reload(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  }
  const all = list.data?.appointments ?? [];
  const arriving = all.filter((a) => a.status === 'scheduled' || a.status === 'confirmed');
  const queue = all.filter((a) => a.status === 'checked_in' || a.status === 'called')
    .sort((x, y) => (x.priority === 'priority' ? 0 : 1) - (y.priority === 'priority' ? 0 : 1) || (x.checkedInAt ?? '').localeCompare(y.checkedInAt ?? ''));
  const inService = all.filter((a) => a.status === 'in_service');
  const wait = (a: Appt) => (a.checkedInAt ? Math.max(0, Math.floor((Date.now() - new Date(a.checkedInAt).getTime()) / 60000)) : 0);

  return (
    <>
      <div className="page-head"><h1>Recepção</h1><Button variant="secondary" className="btn-sm" onClick={list.reload}>Atualizar</Button></div>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}

      {portal && <PortalRequests />}

      <section aria-labelledby="q-title">
        <h2 id="q-title">Fila de espera ({queue.length})</h2>
        {list.data && queue.length === 0 && <Empty title="Ninguém aguardando">Quando alguém chegar, aparece aqui.</Empty>}
        <ul className="list">
          {queue.map((a) => (
            <li key={a.id} className="list-item stack">
              <div className="row between">
                <strong>{a.patientName}</strong>
                <span className="row">{a.priority === 'priority' && <Badge tone="warn">Prioridade</Badge>}<Badge tone={a.status === 'called' ? 'info' : 'neutral'}>{STATUS_LABEL[a.status]}</Badge></span>
              </div>
              <span className="small muted">Agendado {timeOf(a.startsAt)} · {a.professionalName}{a.resourceName ? ` · ${a.resourceName}` : ''} · aguardando há {wait(a)} min</span>
              {forms && <FormBadges a={a} canTriage={canTriage} onTriage={() => setTriaging(a)} />}
              {canWrite && (
                <div className="row">
                  {a.status === 'checked_in' && <Button className="btn-sm" onClick={() => move(a, { status: 'called' }, `${a.patientName} chamado(a).`)}>Chamar</Button>}
                  <Button className="btn-sm" variant={a.status === 'called' ? 'primary' : 'secondary'} onClick={() => move(a, { status: 'in_service' }, 'Atendimento iniciado.')}>Iniciar atendimento</Button>
                  {a.status === 'called' && <Button className="btn-sm" variant="secondary" onClick={() => move(a, { status: 'checked_in' }, 'Voltou para a fila.')}>Voltar à fila</Button>}
                  {a.status === 'called' && <Button className="btn-sm" variant="secondary" onClick={() => move(a, { status: 'no_show' }, 'Registrado como falta.')}>Não compareceu</Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="s-title">
        <h2 id="s-title">Em atendimento ({inService.length})</h2>
        {list.data && inService.length === 0 && <p className="muted small">Nenhum atendimento em andamento.</p>}
        <ul className="list">
          {inService.map((a) => (
            <li key={a.id} className="list-item stack">
              <div className="row between"><strong>{a.patientName}</strong><Badge tone="info">Em atendimento</Badge></div>
              <span className="small muted">{a.professionalName}{a.resourceName ? ` · ${a.resourceName}` : ''} · {a.service}</span>
              {canWrite && <div className="row"><Button className="btn-sm" onClick={() => move(a, { status: 'completed' }, 'Atendimento concluído.')}>Concluir atendimento</Button><a className="btn btn-secondary btn-sm" href={`#/pacientes/${a.patientId}`}>Abrir ficha</a></div>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="a-title">
        <h2 id="a-title">Ainda vão chegar ({arriving.length})</h2>
        {list.data && arriving.length === 0 && <p className="muted small">Todos os agendados de hoje já chegaram ou foram atendidos.</p>}
        <ul className="list">
          {arriving.map((a) => (
            <li key={a.id} className="list-item stack">
              <div className="row between"><strong>{timeOf(a.startsAt)} · {a.patientName}</strong><Badge>{STATUS_LABEL[a.status]}</Badge></div>
              <span className="small muted">{a.professionalName}{a.resourceName ? ` · ${a.resourceName}` : ''} · {a.service}</span>
              {forms && <FormBadges a={a} canTriage={canTriage} onTriage={() => setTriaging(a)} />}
              {canWrite && (
                <div className="row">
                  <Button className="btn-sm" onClick={() => move(a, { status: 'checked_in' }, `${a.patientName} chegou.`)}>Chegou</Button>
                  <Button variant="secondary" className="btn-sm" onClick={() => move(a, { status: 'checked_in', priority: 'priority' }, `${a.patientName} chegou (prioridade).`)}>Chegou com prioridade</Button>
                  <Button variant="secondary" className="btn-sm" onClick={() => move(a, { status: 'no_show' }, 'Registrado como falta.')}>Faltou</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
      <TriageSheet patientId={triaging?.patientId ?? null} appointmentId={triaging?.id} onClose={() => setTriaging(null)} onDone={() => { setTriaging(null); list.reload(); }} />
    </>
  );
}

function FormBadges({ a, canTriage, onTriage }: { a: Appt; canTriage: boolean; onTriage: () => void }) {
  return (
    <div className="row">
      {!!a.formsPending && <Badge tone="warn">{a.formsPending} formulário(s) aguardando</Badge>}
      {!!a.formsSubmitted && <Badge tone="ok">Formulário respondido</Badge>}
      {a.triageDone ? <Badge tone="ok">Triagem feita</Badge> : canTriage && <Button variant="secondary" className="btn-sm" onClick={onTriage}>Fazer triagem</Button>}
    </div>
  );
}
