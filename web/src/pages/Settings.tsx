import { useState, type FormEvent } from 'react';
import { del, get, post } from '../api';
import { dateTimeOf, toIso } from '../format';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const KIND: Record<string, string> = { room: 'Sala', chair: 'Cadeira', equipment: 'Equipamento' };

export function UnitsRooms({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const units = useLoad(() => get<{ units: { id: string; name: string }[] }>('/api/units'), []);
  const rooms = useLoad(() => get<{ resources: { id: string; name: string; kind: string; unitId: string }[] }>('/api/resources'), []);
  const [unitOpen, setUnitOpen] = useState(false);
  const [roomOpen, setRoomOpen] = useState(false);
  const [name, setName] = useState('');
  const [unitId, setUnitId] = useState('');
  const [kind, setKind] = useState('room');
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent, fn: () => Promise<unknown>, ok: string, close: () => void) {
    e.preventDefault(); setError(null);
    try { await fn(); toast(ok); setName(''); close(); units.reload(); rooms.reload(); } catch (err) { setError((err as Error).message); }
  }
  if (units.loading && !units.data) return <Spinner />;
  if (units.error || !units.data) return <ErrorBox message={units.error ?? 'Erro'} onRetry={units.reload} />;
  return (
    <>
      {canManage && <div className="row"><Button onClick={() => { setError(null); setUnitOpen(true); }}>Nova unidade</Button><Button variant="secondary" disabled={!units.data.units.length} onClick={() => { setError(null); setUnitId(units.data!.units[0]?.id ?? ''); setRoomOpen(true); }}>Nova sala ou equipamento</Button></div>}
      {units.data.units.length === 0 && <Empty title="Nenhuma unidade cadastrada">Cadastre a unidade para depois adicionar salas e cadeiras.</Empty>}
      <ul className="list">
        {units.data.units.map((u) => (
          <li key={u.id} className="list-item stack">
            <strong>{u.name}</strong>
            {(rooms.data?.resources.filter((r) => r.unitId === u.id) ?? []).length === 0 ? <span className="small muted">Sem salas ou equipamentos.</span> :
              <span className="row">{rooms.data?.resources.filter((r) => r.unitId === u.id).map((r) => <Badge key={r.id} tone="info">{KIND[r.kind]}: {r.name}</Badge>)}</span>}
          </li>
        ))}
      </ul>
      <Sheet open={unitOpen} title="Nova unidade" onClose={() => setUnitOpen(false)}>
        <form onSubmit={(e) => save(e, () => post('/api/units', { name }), 'Unidade criada.', () => setUnitOpen(false))} noValidate>
          <TextInput label="Nome da unidade" value={name} onChange={setName} error={error} />
          <Button type="submit" className="btn-block">Criar unidade</Button>
        </form>
      </Sheet>
      <Sheet open={roomOpen} title="Nova sala ou equipamento" onClose={() => setRoomOpen(false)}>
        <form onSubmit={(e) => save(e, () => post('/api/resources', { unitId, name, kind }), 'Cadastrado.', () => setRoomOpen(false))} noValidate>
          <Select label="Unidade" value={unitId} onChange={setUnitId}>{units.data.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
          <Select label="Tipo" value={kind} onChange={setKind}><option value="room">Sala</option><option value="chair">Cadeira</option><option value="equipment">Equipamento</option></Select>
          <TextInput label="Nome" value={name} onChange={setName} error={error} hint="Exemplo: Sala 1." />
          <Button type="submit" className="btn-block">Cadastrar</Button>
        </form>
      </Sheet>
    </>
  );
}

interface Rule { id: string; professionalId: string; professionalName: string; weekday: number; start: string; end: string }

export function Hours({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const rules = useLoad(() => get<{ rules: Rule[] }>('/api/availability'), []);
  const pros = useLoad(() => get<{ professionals: { id: string; name: string }[] }>('/api/professionals'), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ professionalId: '', weekday: '1', start: '08:00', end: '12:00' });
  const [error, setError] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await post('/api/availability', { professionalId: f.professionalId || pros.data?.professionals[0]?.id, weekday: Number(f.weekday), start: f.start, end: f.end }); toast('Horário adicionado.'); setOpen(false); rules.reload(); }
    catch (err) { setError((err as Error).message); }
  }
  async function remove(r: Rule) {
    if (!window.confirm(`Remover ${WEEKDAYS[r.weekday]} ${r.start}–${r.end} de ${r.professionalName}?`)) return;
    try { await del(`/api/availability/${r.id}`); toast('Horário removido.'); rules.reload(); } catch (err) { toast((err as Error).message, 'bad'); }
  }
  if (rules.loading && !rules.data) return <Spinner />;
  if (rules.error || !rules.data) return <ErrorBox message={rules.error ?? 'Erro'} onRetry={rules.reload} />;
  const byPro = new Map<string, Rule[]>();
  for (const r of rules.data.rules) byPro.set(r.professionalName, [...(byPro.get(r.professionalName) ?? []), r]);
  return (
    <>
      <p className="small muted">Profissionais sem horário cadastrado podem ser agendados a qualquer hora. Com horário, agendamentos fora dele só entram como encaixe, pela recepção.</p>
      {canManage && <Button onClick={() => { setError(null); setOpen(true); }}>Adicionar horário</Button>}
      {byPro.size === 0 && <Empty title="Nenhum horário de atendimento cadastrado" />}
      <ul className="list">
        {[...byPro.entries()].map(([name, rs]) => (
          <li key={name} className="list-item stack">
            <strong>{name}</strong>
            {rs.map((r) => (
              <div key={r.id} className="row between"><span>{WEEKDAYS[r.weekday]} · {r.start}–{r.end}</span>{canManage && <Button variant="ghost" className="btn-sm" onClick={() => remove(r)} aria-label={`Remover ${WEEKDAYS[r.weekday]} ${r.start} a ${r.end}`}>Remover</Button>}</div>
            ))}
          </li>
        ))}
      </ul>
      <Sheet open={open} title="Adicionar horário de atendimento" onClose={() => setOpen(false)}>
        <form onSubmit={add} noValidate>
          <Select label="Profissional" value={f.professionalId || pros.data?.professionals[0]?.id || ''} onChange={(v) => setF({ ...f, professionalId: v })}>{pros.data?.professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          <Select label="Dia da semana" value={f.weekday} onChange={(v) => setF({ ...f, weekday: v })}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select>
          <div className="grid2"><TextInput label="Início" type="time" value={f.start} onChange={(v) => setF({ ...f, start: v })} /><TextInput label="Fim" type="time" value={f.end} onChange={(v) => setF({ ...f, end: v })} /></div>
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" className="btn-block">Adicionar horário</Button>
        </form>
      </Sheet>
    </>
  );
}

interface Block { id: string; startsAt: string; endsAt: string; reason: string; professionalName: string | null; resourceName: string | null }

export function Blocks({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const blocks = useLoad(() => get<{ blocks: Block[] }>('/api/blocks'), []);
  const pros = useLoad(() => get<{ professionals: { id: string; name: string }[] }>('/api/professionals'), []);
  const rooms = useLoad(() => get<{ resources: { id: string; name: string }[] }>('/api/resources'), []);
  const [open, setOpen] = useState(false);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const [f, setF] = useState({ scope: 'clinic', target: '', startDate: today, startTime: '00:00', endDate: today, endTime: '23:59', reason: '' });
  const [error, setError] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault(); setError(null);
    const target = f.target || (f.scope === 'professional' ? pros.data?.professionals[0]?.id : rooms.data?.resources[0]?.id);
    try {
      await post('/api/blocks', { startsAt: toIso(f.startDate, f.startTime), endsAt: toIso(f.endDate, f.endTime), reason: f.reason,
        professionalId: f.scope === 'professional' ? target : null, resourceId: f.scope === 'resource' ? target : null });
      toast('Bloqueio criado.'); setOpen(false); setF({ ...f, reason: '' }); blocks.reload();
    } catch (err) { setError((err as Error).message); }
  }
  async function remove(b: Block) {
    if (!window.confirm(`Remover o bloqueio "${b.reason}"? O horário volta a ficar disponível.`)) return;
    try { await del(`/api/blocks/${b.id}`); toast('Bloqueio removido.'); blocks.reload(); } catch (err) { toast((err as Error).message, 'bad'); }
  }
  if (blocks.loading && !blocks.data) return <Spinner />;
  if (blocks.error || !blocks.data) return <ErrorBox message={blocks.error ?? 'Erro'} onRetry={blocks.reload} />;
  return (
    <>
      <p className="small muted">Feriados, folgas e manutenções. Não é possível bloquear um período que já tenha consultas marcadas: remarque antes.</p>
      {canManage && <Button onClick={() => { setError(null); setOpen(true); }}>Novo bloqueio</Button>}
      {blocks.data.blocks.length === 0 && <Empty title="Nenhum bloqueio ativo" />}
      <ul className="list">
        {blocks.data.blocks.map((b) => (
          <li key={b.id} className="list-item stack">
            <div className="row between"><strong>{b.reason}</strong><Badge tone="warn">{b.professionalName ?? b.resourceName ?? 'Clínica inteira'}</Badge></div>
            <span className="small muted">{dateTimeOf(b.startsAt)} → {dateTimeOf(b.endsAt)}</span>
            {canManage && <Button variant="secondary" className="btn-sm" onClick={() => remove(b)}>Remover bloqueio</Button>}
          </li>
        ))}
      </ul>
      <Sheet open={open} title="Novo bloqueio" onClose={() => setOpen(false)}>
        <form onSubmit={add} noValidate>
          <Select label="O que bloquear" value={f.scope} onChange={(v) => setF({ ...f, scope: v, target: '' })}><option value="clinic">Clínica inteira (feriado)</option><option value="professional">Um profissional</option><option value="resource">Uma sala ou equipamento</option></Select>
          {f.scope === 'professional' && <Select label="Profissional" value={f.target || pros.data?.professionals[0]?.id || ''} onChange={(v) => setF({ ...f, target: v })}>{pros.data?.professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}
          {f.scope === 'resource' && <Select label="Sala ou equipamento" value={f.target || rooms.data?.resources[0]?.id || ''} onChange={(v) => setF({ ...f, target: v })}>{rooms.data?.resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}
          <div className="grid2"><TextInput label="Início (data)" type="date" value={f.startDate} onChange={(v) => setF({ ...f, startDate: v })} /><TextInput label="Início (hora)" type="time" value={f.startTime} onChange={(v) => setF({ ...f, startTime: v })} />
            <TextInput label="Fim (data)" type="date" value={f.endDate} onChange={(v) => setF({ ...f, endDate: v })} /><TextInput label="Fim (hora)" type="time" value={f.endTime} onChange={(v) => setF({ ...f, endTime: v })} /></div>
          <TextInput label="Motivo" value={f.reason} onChange={(v) => setF({ ...f, reason: v })} hint="Exemplo: Feriado municipal." />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" className="btn-block">Criar bloqueio</Button>
        </form>
      </Sheet>
    </>
  );
}
