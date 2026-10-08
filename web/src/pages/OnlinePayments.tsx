import { useEffect, useState, type FormEvent } from 'react';
import { get, post, api } from '../api';
import { brl, dateTimeOf, parseMoney } from '../format';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

interface Intent {
  id: string; patientId: string; patientName: string; amountCents: string; description: string; method: 'pix' | 'link';
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'refunded'; provider: 'mercadopago' | 'sandbox';
  checkoutUrl: string | null; pixQrCode: string | null; pixQrBase64: string | null; expiresAt: string; expired: boolean; createdAt: string;
  paidMethod: 'pix' | 'card' | null; receiptNumber: number | null; paymentMovementId: string | null; refundedCents?: string; maxInstallments?: number; notice?: string;
}
const STATUS: Record<Intent['status'], { label: string; tone: 'neutral' | 'info' | 'ok' | 'bad' | 'warn' }> = {
  pending: { label: 'Aguardando pagamento', tone: 'warn' }, approved: { label: 'Pago', tone: 'ok' }, rejected: { label: 'Recusado', tone: 'bad' },
  cancelled: { label: 'Cancelado', tone: 'neutral' }, expired: { label: 'Expirado', tone: 'neutral' }, refunded: { label: 'Estornado', tone: 'info' },
};

async function copy(text: string, toast: (m: string, t?: 'ok' | 'bad') => void) {
  try { await navigator.clipboard.writeText(text); toast('Copiado.'); } catch { toast('Não foi possível copiar. Selecione o texto e copie manualmente.', 'bad'); }
}

/** Cobranças online (Pix e link) de um paciente: criar, acompanhar, cancelar e estornar. */
export function OnlineCharges({ patientId, balanceCents, canCharge, canRefund, onChanged }: { patientId: string; balanceCents: string; canCharge: boolean; canRefund: boolean; onChanged: () => void }) {
  const toast = useToast();
  const list = useLoad(() => get<{ intents: Intent[] }>(`/api/payments/intents?patientId=${patientId}`), [patientId]);
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<Intent | null>(null);
  const [f, setF] = useState({ amount: '', method: 'pix', email: '', description: 'Atendimento odontológico', installments: '1' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [refunding, setRefunding] = useState<Intent | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [reason, setReason] = useState('');

  const refresh = () => { list.reload(); onChanged(); };
  function open() {
    const owed = Number(balanceCents);
    setF({ ...f, amount: owed > 0 ? (owed / 100).toFixed(2).replace('.', ',') : '' }); setError(null); setCreating(true);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const cents = parseMoney(f.amount);
    if (!cents || cents < 100) { setError('Informe um valor de pelo menos R$ 1,00.'); return; }
    setBusy('create'); setError(null);
    try {
      const r = await post<Intent>('/api/payments/intents', { patientId, amountCents: cents, method: f.method, payerEmail: f.email || undefined, description: f.description, idempotencyKey: key, ...(f.method === 'link' && Number(f.installments) > 1 ? { maxInstallments: Number(f.installments) } : {}) });
      setCreating(false); setShown(r); setKey(crypto.randomUUID()); list.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  async function act(i: Intent, what: 'sync' | 'cancel' | 'sandbox-approve') {
    setBusy(i.id + what);
    try {
      const r = await post<Intent>(`/api/payments/intents/${i.id}/${what}`);
      if (r.notice) toast(r.notice); else if (what === 'cancel') toast('Cobrança cancelada.'); else if (r.status === 'approved') toast('Pagamento confirmado.');
      else if (what === 'sync') toast('Ainda aguardando o pagamento.');
      if (shown?.id === i.id) setShown(r);
      refresh();
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(null); }
  }

  async function refund(e: FormEvent) {
    e.preventDefault();
    if (!refunding) return;
    setBusy('refund'); setError(null);
    try {
      const cents = refundAmount.trim() ? parseMoney(refundAmount) : undefined;
      if (cents === null) { setError('Valor inválido. Use o formato 50,00 ou deixe vazio para devolver tudo que resta.'); setBusy(null); return; }
      const r = await api<Intent>('POST', `/api/payments/intents/${refunding.id}/refund`, { reason, amountCents: cents });
      toast(r.notice ?? 'Estorno registrado.'); setRefunding(null); setReason(''); setRefundAmount(''); refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  // Enquanto a tela do Pix/link está aberta e a cobrança pendente, confere a cada 5 s (o webhook costuma chegar antes).
  useEffect(() => {
    if (!shown || shown.status !== 'pending') return;
    const t = setInterval(async () => {
      try {
        const r = await post<Intent>(`/api/payments/intents/${shown.id}/sync`);
        if (r.status !== 'pending') { setShown(r); list.reload(); onChanged(); if (r.status === 'approved') toast('Pagamento confirmado.'); }
      } catch { /* tenta de novo no próximo ciclo */ }
    }, 5000);
    return () => clearInterval(t);
  }, [shown?.id, shown?.status]);

  return (
    <section className="card" aria-labelledby="online-title">
      <div className="row between"><h2 id="online-title">Cobranças online</h2>{canCharge && <Button className="btn-sm" onClick={open}>Cobrar online</Button>}</div>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data?.intents.length === 0 && <Empty title="Nenhuma cobrança online">Gere um Pix ou um link de pagamento para o paciente.</Empty>}
      <ul className="list">
        {list.data?.intents.map((i) => {
          const st = i.expired ? { label: 'Expirada', tone: 'neutral' as const } : STATUS[i.status];
          return (
            <li key={i.id} className="list-item stack">
              <div className="row between"><strong>{brl(i.amountCents)} · {i.method === 'pix' ? 'Pix' : 'Link de pagamento'}{(i.maxInstallments ?? 1) > 1 ? ` · até ${i.maxInstallments}x` : ''}</strong><span className="row">{i.status === 'approved' && Number(i.refundedCents ?? 0) > 0 && <Badge tone="info">Estornado {brl(i.refundedCents!)}</Badge>}<Badge tone={st.tone}>{st.label}</Badge></span></div>
              <span className="small muted">{dateTimeOf(i.createdAt)} · {i.description}{i.provider === 'sandbox' ? ' · modo de teste' : ''}{i.receiptNumber ? ` · recibo nº ${i.receiptNumber}` : ''}</span>
              <div className="row">
                {i.status === 'pending' && <Button variant="secondary" className="btn-sm" onClick={() => setShown(i)}>{i.method === 'pix' ? 'Ver Pix' : 'Ver link'}</Button>}
                {canCharge && i.status === 'pending' && <Button className="btn-sm" busy={busy === i.id + 'sync'} onClick={() => act(i, 'sync')}>Verificar</Button>}
                {canCharge && i.status === 'pending' && i.provider === 'sandbox' && <Button variant="secondary" className="btn-sm" busy={busy === i.id + 'sandbox-approve'} onClick={() => act(i, 'sandbox-approve')}>Simular pagamento (teste)</Button>}
                {canCharge && i.status === 'pending' && <Button variant="ghost" className="btn-sm" onClick={() => act(i, 'cancel')}>Cancelar</Button>}
                {i.status === 'approved' && <a className="btn btn-secondary btn-sm" href={`#/recibo/${i.paymentMovementId ?? ''}`}>Ver recibo</a>}
                {canRefund && i.status === 'approved' && <Button variant="danger" className="btn-sm" onClick={() => { setReason(''); setRefundAmount(''); setError(null); setRefunding(i); }}>Estornar</Button>}
              </div>
            </li>
          );
        })}
      </ul>

      <Sheet open={creating} title="Cobrar online" onClose={() => setCreating(false)}>
        <form onSubmit={create} noValidate>
          <TextInput label="Valor (R$)" value={f.amount} onChange={(v) => setF({ ...f, amount: v })} inputMode="decimal" placeholder="150,00" />
          <Select label="Forma" value={f.method} onChange={(v) => setF({ ...f, method: v })}><option value="pix">Pix (QR Code e copia e cola)</option><option value="link">Link de pagamento (cartão, Pix ou saldo)</option></Select>
          {f.method === 'link' && (
            <Select label="Parcelamento no cartão (até)" value={f.installments} onChange={(v) => setF({ ...f, installments: v })}>
              <option value="1">À vista</option>{[2, 3, 4, 5, 6, 8, 10, 12].map((n) => <option key={n} value={n}>{n}x</option>)}
            </Select>
          )}
          <TextInput label="E-mail do pagador" value={f.email} onChange={(v) => setF({ ...f, email: v })} inputMode="email" hint="Se ficar em branco, usamos o e-mail do cadastro. O Pix exige um e-mail." />
          <TextInput label="Descrição" value={f.description} onChange={(v) => setF({ ...f, description: v })} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" busy={busy === 'create'} className="btn-block">Gerar cobrança</Button>
        </form>
      </Sheet>

      <Sheet open={shown !== null} title={shown?.method === 'pix' ? 'Pix gerado' : 'Link de pagamento'} onClose={() => setShown(null)}>
        {shown && (
          <div className="stack">
            <p><strong>{brl(shown.amountCents)}</strong> · <Badge tone={STATUS[shown.status].tone}>{STATUS[shown.status].label}</Badge></p>
            {shown.status === 'approved' && <div className="banner" role="status">Pagamento confirmado e lançado no financeiro do paciente{shown.receiptNumber ? ` (recibo nº ${shown.receiptNumber})` : ''}.</div>}
            {shown.status === 'pending' && shown.method === 'pix' && <>
              {shown.pixQrBase64 && <img alt="QR Code do Pix" width={220} height={220} src={`data:image/png;base64,${shown.pixQrBase64}`} />}
              <label className="field"><span>Pix copia e cola</span><textarea readOnly rows={4} value={shown.pixQrCode ?? ''} onFocus={(e) => e.currentTarget.select()} /></label>
              <Button onClick={() => copy(shown.pixQrCode ?? '', toast)}>Copiar código Pix</Button>
            </>}
            {shown.status === 'pending' && shown.method === 'link' && <>
              <label className="field"><span>Link</span><textarea readOnly rows={3} value={shown.checkoutUrl ?? ''} onFocus={(e) => e.currentTarget.select()} /></label>
              <div className="row"><Button onClick={() => copy(shown.checkoutUrl ?? '', toast)}>Copiar link</Button><a className="btn btn-secondary" href={shown.checkoutUrl ?? '#'} target="_blank" rel="noopener noreferrer">Abrir</a></div>
            </>}
            {shown.status === 'pending' && <p className="small muted" role="status">Aguardando o pagamento. Esta tela confere sozinha a cada poucos segundos. Expira em {dateTimeOf(shown.expiresAt)}.{shown.provider === 'sandbox' ? ' Modo de teste: nada é cobrado de verdade.' : ''}</p>}
          </div>
        )}
      </Sheet>

      <Sheet open={refunding !== null} title="Estornar pagamento online" onClose={() => setRefunding(null)}>
        <form onSubmit={refund} noValidate>
          {refunding && (
            <>
              <p>Pago: <strong>{brl(refunding.amountCents)}</strong>{Number(refunding.refundedCents ?? 0) > 0 ? ` · já devolvido ${brl(refunding.refundedCents!)}` : ''}. Ainda dá para devolver <strong>{brl(String(BigInt(refunding.amountCents) - BigInt(refunding.refundedCents ?? '0')))}</strong>; a devolução é feita pelo Mercado Pago e lançada no financeiro.</p>
              <TextInput label="Valor a devolver (R$, opcional)" value={refundAmount} onChange={setRefundAmount} inputMode="decimal" hint="Deixe vazio para devolver tudo que resta. Preencha para um estorno parcial." />
            </>
          )}
          <TextInput label="Motivo do estorno" value={reason} onChange={setReason} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <Button type="submit" variant="danger" busy={busy === 'refund'} className="btn-block">{refundAmount.trim() ? 'Estornar parte' : 'Estornar tudo que resta'}</Button>
        </form>
      </Sheet>
    </section>
  );
}

interface SettingsData { mode: 'disabled' | 'sandbox' | 'live'; tokenConfigured: boolean; tokenLast4: string | null; webhookSecretConfigured: boolean; notificationUrl: string | null; publicBaseUrlConfigured: boolean; production: boolean }

/** Gestão → Pagamentos: modo e credenciais do Mercado Pago da clínica. O Access Token nunca volta do servidor. */
export function PaymentsSettings() {
  const toast = useToast();
  const s = useLoad(() => get<SettingsData>('/api/payments/settings'), []);
  const [f, setF] = useState({ mode: '', token: '', secret: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (s.data) setF((p) => ({ ...p, mode: s.data!.mode })); }, [s.data?.mode]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api('PUT', '/api/payments/settings', { mode: f.mode, accessToken: f.token || undefined, webhookSecret: f.secret || undefined });
      toast('Configuração salva.'); setF((p) => ({ ...p, token: '', secret: '' })); s.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function clear() {
    if (!window.confirm('Remover o Access Token e o segredo do webhook desta clínica? Os pagamentos online param até serem configurados de novo.')) return;
    try { await api('PUT', '/api/payments/settings', { mode: 'disabled', clearCredentials: true }); toast('Credenciais removidas.'); s.reload(); } catch (err) { toast((err as Error).message, 'bad'); }
  }

  if (s.loading && !s.data) return <Spinner />;
  if (s.error || !s.data) return <ErrorBox message={s.error ?? 'Erro'} onRetry={s.reload} />;
  const d = s.data;
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row between"><h2>Mercado Pago</h2><Badge tone={d.mode === 'live' ? 'ok' : d.mode === 'sandbox' ? 'info' : 'neutral'}>{d.mode === 'live' ? 'Produção' : d.mode === 'sandbox' ? 'Modo de teste' : 'Desativado'}</Badge></div>
        <p className="small muted">Cada clínica usa a própria conta do Mercado Pago: o dinheiro cai direto nela. O sistema gera Pix e links, confirma o pagamento sozinho e lança no financeiro com recibo.</p>
        <form onSubmit={save} noValidate>
          <Select label="Modo" value={f.mode} onChange={(v) => setF({ ...f, mode: v })}>
            <option value="disabled">Desativado</option>
            {!d.production && <option value="sandbox">Teste interno (simulado, sem dinheiro)</option>}
            <option value="live">Mercado Pago (conta real ou credenciais de teste do Mercado Pago)</option>
          </Select>
          <TextInput label="Access Token" type="password" value={f.token} onChange={(v) => setF({ ...f, token: v })} autoComplete="off"
            hint={d.tokenConfigured ? `Configurado (termina em ${d.tokenLast4}). Preencha só para trocar.` : 'No painel de desenvolvedores do Mercado Pago, em Credenciais. Comece pelas credenciais de TESTE.'} />
          <TextInput label="Segredo do webhook (assinatura secreta)" type="password" value={f.secret} onChange={(v) => setF({ ...f, secret: v })} autoComplete="off"
            hint={d.webhookSecretConfigured ? 'Configurado. Preencha só para trocar.' : 'Mostrado no Mercado Pago ao cadastrar a URL de notificação.'} />
          {error && <p className="field-msg error" role="alert">{error}</p>}
          <div className="row"><Button type="submit" busy={busy}>Salvar</Button>{(d.tokenConfigured || d.webhookSecretConfigured) && <Button type="button" variant="ghost" onClick={clear}>Remover credenciais</Button>}</div>
        </form>
      </div>
      <div className="card stack">
        <h2>Como conectar</h2>
        <ol className="small">
          <li>No Mercado Pago, crie um aplicativo em “Suas integrações” e copie o <strong>Access Token</strong> (use o de teste primeiro).</li>
          <li>Em Webhooks, cadastre a URL abaixo, marque o evento <strong>Pagamentos</strong> e copie a <strong>assinatura secreta</strong>.</li>
          <li>Cole as duas informações acima, escolha o modo “Mercado Pago” e salve.</li>
          <li>Gere um Pix de R$ 1,00 na ficha de um paciente e confira se aparece como pago.</li>
        </ol>
        {d.publicBaseUrlConfigured && d.notificationUrl
          ? <label className="field"><span>URL de notificação (webhook)</span><input readOnly value={d.notificationUrl} onFocus={(e) => e.currentTarget.select()} /></label>
          : <div className="banner" role="note">O servidor ainda não conhece o endereço público (variável <code>PUBLIC_BASE_URL</code>). Sem ele o Mercado Pago não consegue avisar os pagamentos; use o botão “Verificar” em cada cobrança.</div>}
        <p className="small muted">Estado desta integração: adaptador escrito e testado com um servidor simulado; ainda <strong>não validado com o Mercado Pago real</strong>. Faça o teste de R$ 1,00 antes de usar com pacientes.</p>
      </div>
    </div>
  );
}
