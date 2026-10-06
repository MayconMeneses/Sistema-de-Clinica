const TZ = 'America/Sao_Paulo';

export const brl = (cents: string | number) =>
  (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** "150,50" | "150.5" | "150" -> centavos; null se inválido. */
export function parseMoney(input: string): number | null {
  const s = input.trim().replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
export const dateTimeOf = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ });
export const dayLabel = (ymd: string) =>
  new Date(`${ymd}T12:00:00-03:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', timeZone: TZ });

export function todayYmd(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}
export function shiftDay(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00-03:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}
/** Início/fim do dia no fuso de São Paulo (UTC-3, sem horário de verão). */
export const dayRange = (ymd: string) => ({ from: `${ymd}T00:00:00-03:00`, to: `${shiftDay(ymd, 1)}T00:00:00-03:00` });
export const toIso = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00-03:00`).toISOString();

export const ROLE_LABEL: Record<string, string> = {
  owner: 'Proprietário', admin: 'Administrador', receptionist: 'Recepção', professional: 'Profissional', finance: 'Financeiro',
};
export const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Agendado', confirmed: 'Confirmado', checked_in: 'Na recepção', called: 'Chamado', in_service: 'Em atendimento', completed: 'Concluído', cancelled: 'Cancelado', no_show: 'Faltou',
};
export const METHOD_LABEL: Record<string, string> = { pix: 'Pix', card: 'Cartão', cash: 'Dinheiro' };
export const KIND_LABEL: Record<string, string> = { charge: 'Cobrança', payment: 'Pagamento', refund: 'Estorno' };
