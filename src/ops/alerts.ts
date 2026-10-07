import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { integrationEnv } from '../server/config.js';
import { escapeHtml, SandboxAlertTransport, TelegramTransport, type AlertTransport } from '../integrations/alerts/telegram.js';

/**
 * Alertas operacionais: avisa a equipe da plataforma (Telegram) quando algo dá errado, dizendo QUAL sistema/componente
 * e QUAL clínica (cliente). Nunca envia dados de paciente, SQL, stack, token, senha, e-mail ou CPF: todo texto passa por
 * `scrub` e as rotas aparecem como padrão (`/api/patients/:id`), nunca como URL crua.
 */
export type Severity = 'info' | 'warning' | 'critical';
export type Component = 'api' | 'worker' | 'banco' | 'web' | 'pagamentos' | 'mensageria' | 'sistema' | 'clientes';

export interface AlertInput {
  severity: Severity;
  component: Component;
  title: string;
  detail?: string;
  route?: string;
  /** Onde no código o erro nasceu (arquivo:linha). Vem de `locateError`; nunca contém dados. */
  where?: string;
  /** Código para buscar o caso nos logs (id da requisição). */
  ref?: string;
  tenant?: { id?: string; name?: string } | null;
  /** Agrupa alertas repetidos; padrão: componente + rota + título sem números. */
  fingerprint?: string;
}
export type NotifyResult = 'sent' | 'deduped' | 'muted' | 'flood' | 'failed' | 'disabled';
export interface AlertRecord { at: string; severity: Severity; component: Component; title: string; tenant?: string; route?: string; result: NotifyResult }

const ICON: Record<Severity, string> = { critical: '🔴', warning: '🟠', info: '🔵' };
const LABEL: Record<Severity, string> = { critical: 'CRÍTICO', warning: 'ATENÇÃO', info: 'AVISO' };
const FLOOD_MAX = 20;
const FLOOD_WINDOW_MS = 10 * 60_000;

/** Remove do texto tudo que possa identificar pessoa ou dar acesso. */
export function scrub(s: string, max = 300): string {
  return s
    .replace(/bot\d{5,}:[\w-]{20,}/gi, 'bot[token]')
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, '$1 [oculto]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'")]+/gi, '[url]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[cpf]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[segredo]')
    .replace(/\(([^()]{1,200})\)=\(([^()]{0,200})\)/g, '(…)=(…)') // "Key (email)=(x@y)" do PostgreSQL
    .replace(/\b\d{8,}\b/g, '[nº]')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Resumo seguro de um erro: tipo, código e mensagem higienizada. Sem stack. */
export function safeErrorSummary(err: unknown): string {
  const e = err as { name?: string; code?: string; message?: string } | null;
  if (!e || typeof e !== 'object') return 'erro desconhecido';
  const parts = [e.name ?? 'Error', e.code ? `[${String(e.code).slice(0, 20)}]` : '', e.message ? scrub(String(e.message), 200) : ''];
  return parts.filter(Boolean).join(' ');
}

/** Primeiro ponto do NOSSO código na pilha do erro (arquivo:linha). Ignora node_modules e internos do Node; a pilha em si nunca é enviada. */
export function locateError(err: unknown): string | undefined {
  const stack = (err as { stack?: string } | null)?.stack;
  if (typeof stack !== 'string') return undefined;
  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('node_modules') || line.includes('node:internal')) continue;
    const m = line.match(/((?:src|scripts)\/[\w./-]+\.(?:ts|js|tsx)):(\d+)(?::\d+)?/);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return undefined;
}

export const routePattern = (req: { routeOptions?: { url?: string }; method?: string }) =>
  req.routeOptions?.url ? `${req.method ?? ''} ${req.routeOptions.url}`.trim() : undefined;

const fmtTime = (d: Date) => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' });

export interface NotifierOptions {
  transport: AlertTransport | null;
  /** Pool com acesso a ops_alert_state (platform ou worker). Sem pool, silenciar fica só em memória. */
  pool?: pg.Pool;
  envLabel: string;
  dedupeMinutes: number;
  now?: () => number;
}

export class Notifier {
  private seen = new Map<string, { at: number; suppressed: number }>();
  private sentTimes: number[] = [];
  private floodWarnedAt = 0;
  private memMutedUntil = 0;
  readonly recent: AlertRecord[] = [];
  constructor(private o: NotifierOptions) {}

  private now() { return (this.o.now ?? Date.now)(); }
  get transportName() { return this.o.transport?.name ?? 'desligado'; }
  get transport() { return this.o.transport; }
  get envLabel() { return this.o.envLabel; }

  async mutedUntil(): Promise<number> {
    let until = this.memMutedUntil;
    if (this.o.pool) {
      try {
        const r = await this.o.pool.query<{ until: string | null }>(`SELECT value->>'until' AS until FROM ops_alert_state WHERE key = 'mute'`);
        const v = r.rows[0]?.until ? Date.parse(r.rows[0].until) : 0;
        if (Number.isFinite(v)) until = Math.max(until, v);
      } catch { /* banco indisponível: alerta não pode depender dele para ser entregue */ }
    }
    return until > this.now() ? until : 0;
  }
  async mute(minutes: number): Promise<Date> {
    const until = new Date(this.now() + minutes * 60_000);
    this.memMutedUntil = until.getTime();
    if (this.o.pool) {
      await this.o.pool.query(
        `INSERT INTO ops_alert_state (key, value) VALUES ('mute', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify({ until: until.toISOString() })]).catch(() => undefined);
    }
    return until;
  }
  async unmute() {
    this.memMutedUntil = 0;
    if (this.o.pool) await this.o.pool.query(`UPDATE ops_alert_state SET value = '{}', updated_at = now() WHERE key = 'mute'`).catch(() => undefined);
  }

  private record(a: AlertInput, result: NotifyResult) {
    this.recent.push({ at: new Date(this.now()).toISOString(), severity: a.severity, component: a.component, title: a.title, tenant: a.tenant?.name, route: a.route, result });
    if (this.recent.length > 50) this.recent.shift();
  }

  format(a: AlertInput, repeats = 0): string {
    const lines = [
      `${ICON[a.severity]} <b>${LABEL[a.severity]}</b> · ${escapeHtml(a.component)} · ${escapeHtml(this.o.envLabel)}`,
      `<b>${escapeHtml(scrub(a.title, 160))}</b>`,
    ];
    if (a.tenant?.name || a.tenant?.id) lines.push(`Clínica: ${escapeHtml(scrub(a.tenant.name ?? '', 80) || '—')}${a.tenant.id ? ` (${a.tenant.id.slice(0, 8)})` : ''}`);
    if (a.route) lines.push(`Rota: <code>${escapeHtml(scrub(a.route, 120))}</code>`);
    if (a.where) lines.push(`Onde: <code>${escapeHtml(scrub(a.where, 120))}</code>`);
    if (a.detail) lines.push(escapeHtml(scrub(a.detail, 300)));
    if (a.ref) lines.push(`Buscar nos logs: <code>${escapeHtml(scrub(a.ref, 40))}</code>`);
    if (repeats > 0) lines.push(`↻ repetido ${repeats}x desde o último aviso`);
    lines.push(`🕒 ${fmtTime(new Date(this.now()))}`);
    return lines.join('\n');
  }

  async notify(a: AlertInput): Promise<NotifyResult> {
    try {
      const now = this.now();
      const fp = a.fingerprint ?? `${a.component}|${a.route ?? ''}|${a.title.replace(/\d+/g, '#')}`;
      const windowMs = this.o.dedupeMinutes * 60_000;
      const prev = this.seen.get(fp);
      if (prev && now - prev.at < windowMs) { prev.suppressed++; this.record(a, 'deduped'); return 'deduped'; }
      if (!this.o.transport) { this.record(a, 'disabled'); return 'disabled'; }
      if (a.severity !== 'critical' && await this.mutedUntil()) { this.record(a, 'muted'); return 'muted'; } // crítico fura o silêncio

      this.sentTimes = this.sentTimes.filter((t) => now - t < FLOOD_WINDOW_MS);
      if (this.sentTimes.length >= FLOOD_MAX) {
        if (now - this.floodWarnedAt > FLOOD_WINDOW_MS) {
          this.floodWarnedAt = now;
          await this.o.transport.send(`🟣 <b>Muitos alertas</b> · ${escapeHtml(this.o.envLabel)}\nMais de ${FLOOD_MAX} avisos em 10 minutos; os próximos serão resumidos em /erros. Verifique o sistema.`).catch(() => undefined);
        }
        this.record(a, 'flood'); return 'flood';
      }
      this.sentTimes.push(now);
      this.seen.set(fp, { at: now, suppressed: 0 });
      if (this.seen.size > 500) for (const [k, v] of this.seen) if (now - v.at > windowMs) this.seen.delete(k);

      const res = await this.o.transport.send(this.format(a, prev?.suppressed ?? 0));
      const result: NotifyResult = res.delivered > 0 ? 'sent' : 'failed';
      this.record(a, result);
      return result;
    } catch { return 'failed'; } // alertar nunca derruba quem alertou
  }
}

// ---------------------------------------------------------------- instância do processo
let current: Notifier | null = null;

export function createNotifierFromEnv(pool?: pg.Pool): Notifier {
  const c = integrationEnv().alerts;
  const live = !!(c.token && c.chatIds.length);
  const transport: AlertTransport | null = live
    ? new TelegramTransport(c.token!, c.chatIds, c.apiBase)
    : integrationEnv().defaultMode === 'sandbox' ? new SandboxAlertTransport() : null;
  return new Notifier({ transport, pool, envLabel: c.envLabel, dedupeMinutes: Math.max(0, c.dedupeMinutes || 5) });
}
export function initAlerts(pool?: pg.Pool): Notifier {
  if (!current) current = createNotifierFromEnv(pool);
  return current;
}
export const getNotifier = () => current;
export function resetAlertsForTests() { current = null; }

export function notify(a: AlertInput): void { void current?.notify(a); }
export function reportError(err: unknown, ctx: Omit<AlertInput, 'severity' | 'title' | 'detail'> & { severity?: Severity; title?: string }): void {
  notify({ severity: 'critical', title: 'Erro inesperado', where: locateError(err), ...ctx, detail: safeErrorSummary(err) });
}

/** Captura falhas que escapariam de tudo (processo prestes a cair). Chamar uma vez por processo. */
export function installProcessHandlers(component: Component) {
  process.on('unhandledRejection', (r) => { reportError(r, { component, title: 'Promessa rejeitada sem tratamento' }); });
  process.on('uncaughtException', (e) => {
    reportError(e, { component, title: 'Falha fatal: o processo vai reiniciar' });
    setTimeout(() => process.exit(1), 2000).unref(); // dá tempo de o aviso sair
  });
}

/** Versão do sistema (package.json), para /status. */
export function appVersion(): string {
  try { return (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? 'dev'; } catch { return 'dev'; }
}
