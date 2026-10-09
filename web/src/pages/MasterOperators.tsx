import { useState, type FormEvent } from 'react';
import { get, patch, post } from '../api';
import { Badge, Button, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';
import { useMasterMfa } from '../useMfa';

interface Op { id: string; name: string; email: string; role: string; status: 'active' | 'suspended' }
interface Data { operators: Op[]; roles: { key: string; label: string }[] }

const HELP: Record<string, string> = {
  admin: 'Tudo, inclusive gerenciar operadores.',
  clinics: 'Cadastro, plano, situação e funcionalidades das clínicas; 2 etapas do proprietário.',
  billing: 'Preços, faturas, baixa e inadimplência.',
  support: 'Abre o acesso que a clínica liberou; vê e reprocessa integrações.',
  auditor: 'Somente leitura.',
};

/** Plataforma → Operadores (somente administrador): quem opera o painel e com qual papel. */
export function MasterOperators({ meId }: { meId: string }) {
  const toast = useToast();
  const mfa = useMasterMfa();
  const d = useLoad(() => get<Data>('/api/master/operators'), []);
  const [why, setWhy] = useState('');
  const [code, setCode] = useState('');
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ email: string; secret: string; uri: string } | null>(null);
  const label = (k: string) => d.data?.roles.find((r) => r.key === k)?.label ?? k;
  const ready = why.trim().length >= 5 && (!mfa || code.length === 6);

  async function change(o: Op, body: object, ok: string) {
    try { await patch(`/api/master/operators/${o.id}`, { ...body, code, justification: why }); toast(ok); setCode(''); d.reload(); } catch (e) { toast((e as Error).message, 'bad'); }
  }
  return (
    <>
      <div className="page-head"><h1>Operadores</h1><Button onClick={() => setAdding(true)}>Novo operador</Button></div>
      <div className="card stack">
        <TextInput label="Justificativa para as ações desta tela" value={why} onChange={setWhy} hint="Obrigatória e registrada na auditoria." />
        {mfa && <TextInput label="Código MFA atual" value={code} onChange={setCode} inputMode="numeric" maxLength={6} />}
        <p className="small muted">Dê a cada pessoa só o papel de que precisa. Mudar papel, suspender ou trocar a senha encerra as sessões abertas dela.</p>
      </div>
      {d.loading && !d.data && <Spinner />}
      {d.error && <ErrorBox message={d.error} onRetry={d.reload} />}
      <ul className="list">
        {d.data?.operators.map((o) => (
          <li key={o.id} className="list-item stack">
            <div className="row between"><strong>{o.name}{o.id === meId ? ' (você)' : ''}</strong><span className="row"><Badge tone="info">{label(o.role)}</Badge>{o.status === 'active' ? <Badge tone="ok">Ativo</Badge> : <Badge tone="bad">Suspenso</Badge>}</span></div>
            <span className="small muted">{o.email}</span>
            {o.id !== meId && (
              <div className="row">
                <select aria-label={`Papel de ${o.name}`} className="input" value={o.role} disabled={!ready} onChange={(e) => change(o, { role: e.target.value }, 'Papel alterado.')}>{d.data!.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
                <Button variant="secondary" className="btn-sm" disabled={!ready} onClick={() => change(o, { status: o.status === 'active' ? 'suspended' : 'active' }, o.status === 'active' ? 'Operador suspenso.' : 'Operador reativado.')}>{o.status === 'active' ? 'Suspender' : 'Reativar'}</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <AddOperator open={adding} roles={d.data?.roles ?? []} why={why} code={code} ready={ready} onClose={() => setAdding(false)} onDone={(s) => { setAdding(false); setCode(''); setSecret(s); d.reload(); }} />
      <Sheet open={!!secret} title="Entregue ao novo operador" onClose={() => setSecret(null)}>
        <p className="small">Cadastre este segredo no aplicativo autenticador de <strong>{secret?.email}</strong>. Ele aparece <strong>só desta vez</strong>.</p>
        <TextInput label="Segredo do autenticador" value={secret?.secret ?? ''} onChange={() => undefined} />
        <TextInput label="Link otpauth" value={secret?.uri ?? ''} onChange={() => undefined} />
        <Button className="btn-block" onClick={() => setSecret(null)}>Já entreguei</Button>
      </Sheet>
    </>
  );
}

function AddOperator({ open, roles, why, code, ready, onClose, onDone }: { open: boolean; roles: Data['roles']; why: string; code: string; ready: boolean; onClose: () => void; onDone: (s: { email: string; secret: string; uri: string }) => void }) {
  const [f, setF] = useState({ name: '', email: '', role: 'support', password: '' });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      const r = await post<{ totpSecret: string; otpauth: string }>('/api/master/operators', { ...f, code, justification: why });
      onDone({ email: f.email, secret: r.totpSecret, uri: r.otpauth }); setF({ name: '', email: '', role: 'support', password: '' });
    } catch (err) { setError((err as Error).message); }
  }
  return (
    <Sheet open={open} title="Novo operador" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <TextInput label="Nome" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
        <TextInput label="E-mail" type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} />
        <Select label="Papel" value={f.role} onChange={(v) => setF({ ...f, role: v })}>{roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</Select>
        <p className="small muted">{HELP[f.role]}</p>
        <TextInput label="Senha provisória" type="password" value={f.password} onChange={(v) => setF({ ...f, password: v })} autoComplete="new-password" />
        {!ready && <p className="small muted">Preencha a justificativa{code.length !== 6 ? ' e o código MFA' : ''} na tela anterior.</p>}
        {error && <p className="field-msg error" role="alert">{error}</p>}
        <Button type="submit" disabled={!ready} className="btn-block">Criar operador</Button>
      </form>
    </Sheet>
  );
}
