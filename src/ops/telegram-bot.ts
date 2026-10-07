import type pg from 'pg';
import { escapeHtml, TelegramClient, type TelegramUpdate } from '../integrations/alerts/telegram.js';
import { integrationEnv } from '../server/config.js';
import { getNotifier, safeErrorSummary, type Notifier } from './alerts.js';

/**
 * Comandos do bot de operação (Telegram). Só respondem aos chats listados em TELEGRAM_CHAT_IDS.
 * Mostram números agregados (fila, clínicas por situação); nunca dados de paciente.
 */
export const COMMANDS: { cmd: string; help: string }[] = [
  { cmd: '/status', help: 'saúde do sistema: banco, fila, clínicas, alertas silenciados' },
  { cmd: '/erros', help: 'últimos avisos e erros registrados' },
  { cmd: '/clinicas', help: 'clientes cadastrados por situação' },
  { cmd: '/fila', help: 'fila de mensagens (WhatsApp/e-mail/SMS) e webhooks' },
  { cmd: '/silenciar N', help: 'silencia avisos não críticos por N minutos (1 a 1440); críticos continuam' },
  { cmd: '/ativar', help: 'volta a receber todos os avisos' },
  { cmd: '/testar', help: 'envia um aviso de teste para confirmar que o canal funciona' },
  { cmd: '/ajuda', help: 'esta lista' },
];

export interface BotDeps { pool: pg.Pool; notifier: Notifier; version: string; startedAt: number }

export const helpText = () => ['<b>Clínica One · operação</b>', ...COMMANDS.map((c) => `${escapeHtml(c.cmd)} — ${escapeHtml(c.help)}`)].join('\n');

const fmt = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const upFor = (ms: number) => { const m = Math.floor(ms / 60000); return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}min` : `${m}min`; };

/** Executa um comando já autorizado e devolve o texto (HTML) da resposta. Nunca lança. */
export async function runCommand(text: string, d: BotDeps): Promise<string> {
  const [raw, ...args] = text.trim().split(/\s+/);
  const cmd = (raw ?? '').toLowerCase().replace(/@\w+$/, '');
  try {
    switch (cmd) {
      case '/start': case '/ajuda': case '/help': return helpText();
      case '/status': {
        const t0 = Date.now();
        await d.pool.query('SELECT 1');
        const ms = Date.now() - t0;
        const q = await d.pool.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM outbox_events GROUP BY status');
        const dead = q.rows.find((r) => r.status === 'dead')?.n ?? 0;
        const waiting = q.rows.filter((r) => ['pending', 'failed', 'processing'].includes(r.status)).reduce((a, r) => a + r.n, 0);
        const tn = await d.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_directory WHERE status = 'active'`);
        const mutedUntil = await d.notifier.mutedUntil();
        const last = d.notifier.recent.at(-1);
        return [
          `🟢 <b>Sistema no ar</b> · ${escapeHtml(d.notifier.envLabel)} · v${escapeHtml(d.version)}`,
          `Banco: ok (${ms} ms)`,
          `Ligado há ${upFor(Date.now() - d.startedAt)}`,
          `Clínicas ativas: ${tn.rows[0]?.n ?? 0}`,
          `Fila de mensagens: ${waiting} aguardando · ${dead} sem solução${dead ? ' ⚠️' : ''}`,
          mutedUntil ? `🔕 Avisos silenciados até ${fmt(new Date(mutedUntil).toISOString())}` : '🔔 Avisos ligados',
          last ? `Último aviso: ${escapeHtml(last.title)} (${fmt(last.at)})` : 'Nenhum aviso desde que o sistema ligou',
        ].join('\n');
      }
      case '/erros': {
        const items = d.notifier.recent.filter((r) => r.severity !== 'info').slice(-10).reverse();
        if (!items.length) return '✅ Nenhum erro registrado desde que o sistema ligou.';
        return ['<b>Últimos erros</b>', ...items.map((r) => `${fmt(r.at)} · ${escapeHtml(r.component)}${r.tenant ? ` · ${escapeHtml(r.tenant)}` : ''}${r.route ? ` · <code>${escapeHtml(r.route)}</code>` : ''}\n  ${escapeHtml(r.title)}${r.result === 'deduped' ? ' (repetido)' : ''}`)].join('\n');
      }
      case '/clinicas': {
        const r = await d.pool.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM tenant_directory GROUP BY status ORDER BY status');
        if (!r.rowCount) return 'Nenhuma clínica cadastrada ainda.';
        const label: Record<string, string> = { active: 'ativas', suspended: 'suspensas', closed: 'encerradas' };
        return ['<b>Clientes</b>', ...r.rows.map((x) => `${escapeHtml(label[x.status] ?? x.status)}: ${x.n}`)].join('\n');
      }
      case '/fila': {
        const o = await d.pool.query<{ status: string; n: number; oldest: Date | null }>(`SELECT status, count(*)::int AS n, min(next_attempt_at) AS oldest FROM outbox_events WHERE status <> 'sent' AND status <> 'skipped' GROUP BY status ORDER BY status`);
        const w = await d.pool.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM webhook_receipts GROUP BY status ORDER BY status');
        const lines = ['<b>Fila</b>'];
        lines.push(o.rowCount ? 'Mensagens: ' + o.rows.map((x) => `${x.status} ${x.n}`).join(' · ') : 'Mensagens: fila vazia');
        lines.push(w.rowCount ? 'Webhooks: ' + w.rows.map((x) => `${x.status} ${x.n}`).join(' · ') : 'Webhooks: nenhum');
        return lines.join('\n');
      }
      case '/silenciar': {
        const n = Number(args[0]);
        if (!Number.isInteger(n) || n < 1 || n > 1440) return 'Use assim: /silenciar 30 (de 1 a 1440 minutos). Avisos críticos continuam chegando.';
        const until = await d.notifier.mute(n);
        return `🔕 Avisos não críticos silenciados até ${fmt(until.toISOString())}. Use /ativar para voltar.`;
      }
      case '/ativar': await d.notifier.unmute(); return '🔔 Avisos ligados novamente.';
      case '/testar': {
        const r = await d.notifier.notify({ severity: 'info', component: 'sistema', title: 'Teste de alerta', detail: 'Se você leu isto, o canal de alertas funciona.', fingerprint: `teste|${Date.now()}` });
        return r === 'sent' ? '✅ Teste enviado.' : `Teste não entregue (${r}).`;
      }
      default: return 'Comando não reconhecido. Envie /ajuda.';
    }
  } catch (e) { return `⚠️ Não consegui executar: ${escapeHtml(safeErrorSummary(e))}`; }
}

/** Processa uma atualização do Telegram. Chats fora da lista são ignorados (só /start recebe o próprio id, para facilitar a configuração). */
export async function handleUpdate(u: TelegramUpdate, d: BotDeps, client: Pick<TelegramClient, 'sendMessage'>, allowed: string[], hinted: Map<string, number>): Promise<void> {
  const m = u.message;
  if (!m?.text) return;
  const chat = String(m.chat.id);
  if (!allowed.includes(chat)) {
    const last = hinted.get(chat) ?? 0;
    if (/^\/start\b/i.test(m.text) && Date.now() - last > 3_600_000) {
      hinted.set(chat, Date.now());
      await client.sendMessage(chat, `Este chat não está autorizado. Seu id é <code>${escapeHtml(chat)}</code>: peça ao administrador para incluí-lo em TELEGRAM_CHAT_IDS.`).catch(() => undefined);
    }
    return;
  }
  if (!m.text.startsWith('/')) return;
  await client.sendMessage(chat, await runCommand(m.text, d)).catch(() => undefined);
}

/** Laço de long polling. Rodar em UM processo só (o Telegram recusa dois leitores). Devolve a função de parada. */
export function startTelegramBot(pool: pg.Pool, version: string, log: (msg: string, extra?: object) => void = () => undefined) {
  const c = integrationEnv().alerts;
  const notifier = getNotifier();
  if (!c.token || !c.chatIds.length || !notifier) return () => undefined;
  const client = new TelegramClient(c.token, c.apiBase);
  const deps: BotDeps = { pool, notifier, version, startedAt: Date.now() };
  const hinted = new Map<string, number>();
  let stopped = false;
  const ctrl = { timer: undefined as NodeJS.Timeout | undefined };

  const loop = async () => {
    let delay = 0;
    try {
      const st = await pool.query<{ value: { offset?: number } }>(`SELECT value FROM ops_alert_state WHERE key = 'telegram_offset'`);
      let offset = st.rows[0]?.value.offset ?? 0;
      const updates = await client.getUpdates(offset, 25);
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        await handleUpdate(u, deps, client, c.chatIds, hinted).catch(() => undefined);
      }
      if (updates.length) {
        await pool.query(`INSERT INTO ops_alert_state (key, value) VALUES ('telegram_offset', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ offset })]);
      }
    } catch (e) {
      log('telegram_bot_error', { error: safeErrorSummary(e) });
      delay = 30_000; // erro de rede, token inválido ou outro leitor ativo: espera antes de tentar de novo
    }
    if (!stopped) ctrl.timer = setTimeout(() => void loop(), delay);
  };
  ctrl.timer = setTimeout(() => void loop(), 2000);
  return () => { stopped = true; if (ctrl.timer) clearTimeout(ctrl.timer); };
}
