import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, downloadFile, get, post } from '../api';
import { dateTimeOf } from '../format';
import { Badge, Button, Empty, Sheet, TextInput, useToast } from '../ui';

interface Appt { id: string; startsAt: string; endsAt: string; status: string; service: string; professionalName: string; canCancelNow: boolean; canConfirm: boolean; hasOpenRequest: boolean }
interface Doc { id: string; title: string; category: string; fileName: string; sizeBytes: number; createdAt: string }
interface Req { id: string; kind: 'schedule' | 'reschedule' | 'cancel'; message: string | null; status: 'open' | 'done' | 'dismissed'; createdAt: string }
interface Me { clinic: string; patient: { name: string }; cancelMinHours: number; upcoming: Appt[]; past: Appt[]; documents: Doc[]; requests: Req[] }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' }> = {
  scheduled: { label: 'Agendada', tone: 'neutral' }, confirmed: { label: 'Confirmada', tone: 'ok' }, checked_in: { label: 'Chegou', tone: 'info' }, completed: { label: 'Concluída', tone: 'ok' },
  cancelled: { label: 'Cancelada', tone: 'bad' }, no_show: { label: 'Faltou', tone: 'warn' }, in_service: { label: 'Em atendimento', tone: 'info' }, called: { label: 'Chamado', tone: 'info' },
};
const KIND: Record<Req['kind'], string> = { schedule: 'Nova consulta', reschedule: 'Remarcação', cancel: 'Cancelamento' };
const REQ_STATUS = { open: 'Em análise', done: 'Atendido', dismissed: 'Não atendido' } as const;
const CATEGORY: Record<string, string> = { consent: 'Termo', identity: 'Documento', other: 'Documento', exam: 'Exame', report: 'Laudo', xray: 'Radiografia', photo: 'Foto' };

function hashParams(): { clinic: string; token: string } {
  const q = new URLSearchParams((window.location.hash.split('?')[1] ?? ''));
  return { clinic: q.get('clinic') ?? '', token: q.get('token') ?? '' };
}

/** Portal do paciente: entra pelo link da clínica + data de nascimento; só mostra o que é do próprio paciente. */
export function PortalApp() {
  const [params, setParams] = useState(hashParams);
  const clearParams = () => { setParams({ clinic: '', token: '' }); window.history.replaceState(null, '', '#/portal'); };
  const [me, setMe] = useState<Me | null | undefined>(params.token ? null : undefined);
  const [error, setError] = useState<string | null>(null);

  const load = () => get<Me>('/api/portal/me').then((m) => { setMe(m); setError(null); }, (e: Error) => { setMe(null); setError(e instanceof ApiError && e.status === 401 ? null : e.message); });
  useEffect(() => { if (!params.token) void load(); }, []);       // eslint-disable-line react-hooks/exhaustive-deps

  if (me === undefined) return <main className="auth"><p className="loading" role="status">Carregando…</p></main>;
  if (me === null) return <PortalLogin clinic={params.clinic} token={params.token} initialError={error} onDone={() => { clearParams(); void load(); }} />;
  return <PortalHome me={me} reload={load} onLogout={() => { clearParams(); setMe(null); }} />;
}

function PortalLogin({ clinic, token, initialError, onDone }: { clinic: string; token: string; initialError: string | null; onDone: () => void }) {
  const [birth, setBirth] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  if (!token || !clinic) {
    return (
      <main className="auth"><div className="card auth-card">
        <div className="brand"><span className="brand-mark" aria-hidden="true">C</span>Portal do paciente</div>
        <h1>Sessão encerrada</h1>
        <p role="alert">{error ?? 'Para entrar, use o link que a clínica enviou. Se ele venceu, peça um novo à recepção.'}</p>
      </div></main>
    );
  }
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!birth) { setError('Informe sua data de nascimento.'); return; }
    setBusy(true);
    try { await post('/api/portal/login', { clinic, token, birthDate: birth }); onDone(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <main className="auth"><div className="card auth-card">
      <div className="brand"><span className="brand-mark" aria-hidden="true">C</span>Portal do paciente</div>
      <h1>Confirme que é você</h1>
      <form onSubmit={submit} noValidate>
        <TextInput label="Data de nascimento" type="date" value={birth} onChange={setBirth} required autoComplete="bday" />
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" busy={busy} className="btn-block">Entrar</Button>
      </form>
      <p className="small muted">O link é de uso único e vale por tempo limitado. Não compartilhe.</p>
    </div></main>
  );
}

function PortalHome({ me, reload, onLogout }: { me: Me; reload: () => void; onLogout: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ kind: 'schedule' | 'reschedule'; appt?: Appt } | null>(null);
  const [cancelling, setCancelling] = useState<Appt | null>(null);

  async function act(id: string, fn: () => Promise<string | void>) {
    setBusy(id);
    try { const m = await fn(); if (m) toast(m); reload(); } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(null); }
  }
  async function logout() { try { await post('/api/portal/logout'); } catch { /* a sessão já pode ter acabado */ } onLogout(); }
  const first = me.patient.name.split(' ')[0];

  return (
    <main className="portal">
      <header className="row between">
        <div><strong>{me.clinic}</strong><br /><span className="small muted">Olá, {first}</span></div>
        <Button variant="ghost" className="btn-sm" onClick={logout}>Sair</Button>
      </header>

      <section aria-labelledby="p-next" className="stack">
        <div className="row between"><h2 id="p-next">Próximas consultas</h2><Button className="btn-sm" onClick={() => setAsking({ kind: 'schedule' })}>Pedir consulta</Button></div>
        {me.upcoming.length === 0 && <Empty title="Nenhuma consulta marcada">Peça um horário e a clínica retorna para você.</Empty>}
        <ul className="list">
          {me.upcoming.map((a) => (
            <li key={a.id} className="list-item stack">
              <div className="row between"><strong>{dateTimeOf(a.startsAt)}</strong><Badge tone={STATUS[a.status]?.tone}>{STATUS[a.status]?.label ?? a.status}</Badge></div>
              <span className="small muted">{a.service} · {a.professionalName}</span>
              {a.hasOpenRequest && <span className="small">Pedido em análise pela clínica.</span>}
              <div className="row">
                {a.canConfirm && <Button className="btn-sm" busy={busy === a.id} onClick={() => act(a.id, async () => { await post(`/api/portal/appointments/${a.id}/confirm`); return 'Presença confirmada.'; })}>Confirmar presença</Button>}
                <Button variant="secondary" className="btn-sm" onClick={() => setAsking({ kind: 'reschedule', appt: a })}>Pedir outro horário</Button>
                <Button variant="ghost" className="btn-sm" onClick={() => setCancelling(a)}>Cancelar</Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="p-docs" className="stack">
        <h2 id="p-docs">Meus documentos</h2>
        {me.documents.length === 0 && <p className="small muted">Quando a clínica liberar documentos para você, eles aparecem aqui.</p>}
        <ul className="list">
          {me.documents.map((d) => (
            <li key={d.id} className="list-item row between">
              <span><strong>{d.title}</strong><br /><span className="small muted">{CATEGORY[d.category] ?? 'Documento'} · {dateTimeOf(d.createdAt)}</span></span>
              <Button variant="secondary" className="btn-sm" busy={busy === d.id} onClick={() => act(d.id, async () => { await downloadFile(`/api/portal/documents/${d.id}/download`, d.fileName); })}>Baixar</Button>
            </li>
          ))}
        </ul>
      </section>

      {me.requests.length > 0 && (
        <section aria-labelledby="p-req" className="stack">
          <h2 id="p-req">Meus pedidos</h2>
          <ul className="list">
            {me.requests.map((r) => (
              <li key={r.id} className="list-item row between">
                <span><strong>{KIND[r.kind]}</strong><br /><span className="small muted">{r.message ?? ''}</span></span>
                <Badge tone={r.status === 'open' ? 'warn' : r.status === 'done' ? 'ok' : 'neutral'}>{REQ_STATUS[r.status]}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      {me.past.length > 0 && (
        <section aria-labelledby="p-past" className="stack">
          <h2 id="p-past">Últimas consultas</h2>
          <ul className="list">
            {me.past.map((a) => <li key={a.id} className="list-item row between"><span>{dateTimeOf(a.startsAt)}<br /><span className="small muted">{a.service} · {a.professionalName}</span></span><Badge tone={STATUS[a.status]?.tone}>{STATUS[a.status]?.label ?? a.status}</Badge></li>)}
          </ul>
        </section>
      )}

      <AskSheet ask={asking} onClose={() => setAsking(null)} onSent={() => { setAsking(null); toast('Pedido enviado. A clínica vai responder.'); reload(); }} />
      <CancelSheet appt={cancelling} minHours={me.cancelMinHours} onClose={() => setCancelling(null)} onDone={(m) => { setCancelling(null); toast(m); reload(); }} />
    </main>
  );
}

function AskSheet({ ask, onClose, onSent }: { ask: { kind: 'schedule' | 'reschedule'; appt?: Appt } | null; onClose: () => void; onSent: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!ask) return; setError(null); setBusy(true);
    try { await post('/api/portal/requests', { kind: ask.kind, appointmentId: ask.appt?.id, message: text }); setText(''); onSent(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <Sheet open={ask !== null} title={ask?.kind === 'reschedule' ? 'Pedir outro horário' : 'Pedir uma consulta'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {ask?.appt && <p className="small muted">Consulta de {dateTimeOf(ask.appt.startsAt)}.</p>}
        <TextInput label="Qual dia e horário você prefere?" value={text} onChange={setText} hint="Ex.: terças de manhã, ou qualquer dia depois das 17h." />
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" busy={busy}>Enviar pedido</Button>
      </form>
    </Sheet>
  );
}

function CancelSheet({ appt, minHours, onClose, onDone }: { appt: Appt | null; minHours: number; onClose: () => void; onDone: (m: string) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!appt) return; setError(null); setBusy(true);
    try { const r = await post<{ status: string; message?: string }>(`/api/portal/appointments/${appt.id}/cancel`, { reason: reason || undefined }); setReason(''); onDone(r.status === 'cancelled' ? 'Consulta cancelada.' : r.message ?? 'Pedido enviado.'); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <Sheet open={appt !== null} title="Cancelar consulta" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {appt && <p>{dateTimeOf(appt.startsAt)} · {appt.professionalName}</p>}
        <p className="small muted">{appt?.canCancelNow ? 'O cancelamento é imediato.' : `Faltam menos de ${minHours} horas: a clínica precisa aprovar o cancelamento.`}</p>
        <TextInput label="Motivo (opcional)" value={reason} onChange={setReason} />
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <div className="row"><Button type="submit" variant="danger" busy={busy}>{appt?.canCancelNow ? 'Cancelar consulta' : 'Pedir cancelamento'}</Button><Button type="button" variant="ghost" onClick={onClose}>Voltar</Button></div>
      </form>
    </Sheet>
  );
}
