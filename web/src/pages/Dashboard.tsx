import { get, type Me } from '../api';
import { brl, dateTimeOf } from '../format';
import { Badge, ErrorBox, Spinner, useLoad } from '../ui';

export function Dashboard({ me }: { me: Me }) {
  const d = useLoad(() => get<{ patients?: number; appointmentsToday?: number; waiting?: number }>('/api/dashboard'), []);
  const has = (c: string) => me.entitlements.includes(c);
  const fin = useLoad(
    () => (has('finance.basic') && me.permissions.includes('finance.read')
      ? get<{ outstandingCents: string; receivedToday: { method: string; total: string }[] }>('/api/finance/summary')
      : Promise.resolve(null)), []);

  return (
    <>
      <div className="page-head"><h1>Olá, {me.user.name.split(' ')[0]}</h1></div>
      {d.loading && <Spinner />}
      {d.error && <ErrorBox message={d.error} onRetry={d.reload} />}
      {d.data && (
        <div className="stats">
          {d.data.appointmentsToday !== undefined && <div className="stat"><b>{d.data.appointmentsToday}</b><span>Consultas hoje</span></div>}
          {d.data.waiting !== undefined && <div className="stat"><b>{d.data.waiting}</b><span>Na recepção agora</span></div>}
          {d.data.patients !== undefined && <div className="stat"><b>{d.data.patients}</b><span>Pacientes</span></div>}
          {fin.data && <div className="stat"><b>{brl(fin.data.outstandingCents)}</b><span>Em aberto</span></div>}
        </div>
      )}
      {['owner', 'admin'].includes(me.user.role) && <div className="card">
        <h2>Seu plano inclui</h2>
        <p className="row">{me.entitlements.map((e) => <Badge key={e} tone="info">{e}</Badge>)}</p>
        <p className="small muted">Funcionalidades fora do plano são liberadas pelo suporte da plataforma. Convênios/TISS não estão disponíveis nesta fase.</p>
      </div>}
      <p className="small muted">Atualizado em {dateTimeOf(new Date().toISOString())}</p>
    </>
  );
}
