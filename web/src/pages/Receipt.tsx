import { get } from '../api';
import { brl, dateTimeOf, METHOD_LABEL } from '../format';
import { Button, ErrorBox, Spinner, useLoad } from '../ui';

interface ReceiptData {
  number: number | null; amountCents: string; method: string; paidAt: string; note: string | null;
  patientName: string; receivedBy: string | null; clinicName: string; fiscal: boolean;
}

/** Recibo simples de pagamento, pronto para imprimir ou salvar em PDF. Não é documento fiscal. */
export function Receipt({ id }: { id: string }) {
  const r = useLoad(() => get<ReceiptData>(`/api/finance/movements/${id}/receipt`), [id]);
  if (r.loading && !r.data) return <Spinner />;
  if (r.error || !r.data) return <><p><a href="#/financeiro">← Financeiro</a></p><ErrorBox message={r.error ?? 'Recibo não encontrado.'} onRetry={r.reload} /></>;
  const d = r.data;
  return (
    <>
      <p className="no-print"><a href="#/financeiro">← Financeiro</a></p>
      <article className="card receipt" aria-label="Recibo de pagamento">
        <h1>Recibo{d.number ? ` nº ${d.number}` : ''}</h1>
        <p className="muted">{d.clinicName}</p>
        <p>Recebemos de <strong>{d.patientName}</strong> a quantia de <strong>{brl(d.amountCents)}</strong>, paga via {METHOD_LABEL[d.method] ?? d.method}, em {dateTimeOf(d.paidAt)}.</p>
        {d.note && <p>Referente a: {d.note}</p>}
        <p className="small muted">Recebido por {d.receivedBy ?? '—'}.</p>
        <p className="small muted">Este recibo é um comprovante de pagamento e não substitui nota fiscal.</p>
      </article>
      <div className="no-print"><Button onClick={() => window.print()}>Imprimir ou salvar em PDF</Button></div>
    </>
  );
}
