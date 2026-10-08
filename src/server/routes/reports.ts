import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, clinicRoute, type ClinicCtx } from '../context.js';
import { hasPermission } from '../auth/rbac.js';
import { badRequest } from '../http.js';
import { apptInScope, unitScope } from '../scope.js';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const TZ = "'America/Sao_Paulo'";
// Intervalo [início do dia "from", início do dia seguinte a "to") no fuso de São Paulo. Parâmetros: $1 = from, $2 = to.
const FROM = `(($1::date)::timestamp AT TIME ZONE ${TZ})`;
const TO = `((($2::date) + 1)::timestamp AT TIME ZONE ${TZ})`;

type Section = { name: string; cap: string; perm: string; run: (ctx: ClinicCtx, p: [string, string]) => Promise<unknown> };

const SECTIONS: Section[] = [
  { name: 'appointments', cap: 'schedule.core', perm: 'agenda.read', run: async (ctx, p) => {
    const scope = await unitScope(ctx);   // gerente de unidade: só as consultas das suas unidades
    const st = await ctx.tx.query<{ status: string; n: number }>(
      `SELECT a.status, COUNT(*)::int AS n FROM appointments a WHERE a.starts_at >= ${FROM} AND a.starts_at < ${TO} AND ${apptInScope(3)} GROUP BY a.status`, [...p, scope]);
    const by = Object.fromEntries(st.rows.map((r) => [r.status, r.n]));
    const total = st.rows.reduce((a, r) => a + r.n, 0);
    const attended = (by.completed ?? 0), missed = (by.no_show ?? 0);
    const pros = await ctx.tx.query(
      `SELECT u.name, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed,
              COUNT(*) FILTER (WHERE a.status = 'no_show')::int AS "noShow", COUNT(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled
         FROM appointments a JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.professional_id
        WHERE a.starts_at >= ${FROM} AND a.starts_at < ${TO} AND ${apptInScope(3)} GROUP BY u.name ORDER BY total DESC, u.name LIMIT 20`, [...p, scope]);
    // Taxa de falta = faltas ÷ (concluídas + faltas): consultas que de fato deveriam ter acontecido.
    return { total, byStatus: by, noShowRate: attended + missed > 0 ? Math.round((missed / (attended + missed)) * 1000) / 10 : null, byProfessional: pros.rows };
  } },
  { name: 'patients', cap: 'patient.registry', perm: 'patients.read', run: async (ctx, p) => {
    const r = await ctx.tx.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM patients WHERE merged_into IS NULL AND created_at >= ${FROM} AND created_at < ${TO}`, p);
    const t = await ctx.tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM patients WHERE merged_into IS NULL');
    return { newPatients: r.rows[0]!.n, totalActive: t.rows[0]!.n };
  } },
  { name: 'finance', cap: 'finance.basic', perm: 'finance.read', run: async (ctx, p) => {
    const m = await ctx.tx.query<{ kind: string; method: string | null; total: string }>(
      `SELECT kind, method, SUM(amount_cents)::text AS total FROM financial_movements WHERE created_at >= ${FROM} AND created_at < ${TO} GROUP BY kind, method`, p);
    const sum = (kind: string, method?: string) => m.rows.filter((r) => r.kind === kind && (method === undefined || r.method === method)).reduce((a, r) => a + BigInt(r.total), 0n);
    const methods = ['pix', 'card', 'cash'].map((x) => ({ method: x, receivedCents: (sum('payment', x) - sum('refund', x)).toString() }));
    const open = await ctx.tx.query<{ total: string }>(
      `SELECT COALESCE(SUM(GREATEST(bal,0)),0)::text AS total FROM (
         SELECT SUM(CASE kind WHEN 'charge' THEN amount_cents WHEN 'payment' THEN -amount_cents WHEN 'discount' THEN -amount_cents ELSE amount_cents END) AS bal
           FROM financial_movements GROUP BY patient_id) x`);
    const out: Record<string, unknown> = {
      chargedCents: sum('charge').toString(), receivedCents: (sum('payment') - sum('refund')).toString(), refundedCents: sum('refund').toString(),
      discountsCents: sum('discount').toString(), byMethod: methods, outstandingCents: open.rows[0]!.total,
    };
    if (ctx.entitlements.has('finance.advanced')) {
      const c = await ctx.tx.query<{ closed: number; diff: string; pending: number }>(
        `SELECT (SELECT COUNT(*)::int FROM cash_sessions WHERE closed_at >= ${FROM} AND closed_at < ${TO}) AS closed,
                (SELECT COALESCE(SUM(difference_cents),0)::text FROM cash_sessions WHERE closed_at >= ${FROM} AND closed_at < ${TO}) AS diff,
                (SELECT COUNT(*)::int FROM discount_requests WHERE status = 'pending') AS pending`, p);
      out.cash = { closedSessions: c.rows[0]!.closed, differenceCents: c.rows[0]!.diff, pendingDiscounts: c.rows[0]!.pending };
    }
    return out;
  } },
  { name: 'crm', cap: 'crm.pipeline', perm: 'crm.read', run: async (ctx, p) => {
    const st = await ctx.tx.query<{ stage: string; n: number }>(`SELECT stage, COUNT(*)::int AS n FROM crm_leads WHERE created_at >= ${FROM} AND created_at < ${TO} GROUP BY stage`, p);
    const src = await ctx.tx.query<{ source: string; n: number; won: number }>(
      `SELECT source, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE stage = 'won')::int AS won FROM crm_leads WHERE created_at >= ${FROM} AND created_at < ${TO} GROUP BY source ORDER BY n DESC`, p);
    const created = st.rows.reduce((a, r) => a + r.n, 0);
    const won = st.rows.find((r) => r.stage === 'won')?.n ?? 0;
    return { created, byStage: Object.fromEntries(st.rows.map((r) => [r.stage, r.n])), bySource: src.rows, conversionRate: created > 0 ? Math.round((won / created) * 1000) / 10 : null };
  } },
  { name: 'inventory', cap: 'inventory.core', perm: 'inventory.read', run: async (ctx, p) => {
    const r = await ctx.tx.query<{ active: number; low: number }>(
      `SELECT COUNT(*) FILTER (WHERE active)::int AS active,
              COUNT(*) FILTER (WHERE active AND min_quantity > 0 AND COALESCE((SELECT SUM(delta) FROM inventory_movements m WHERE m.tenant_id = i.tenant_id AND m.item_id = i.id),0) <= min_quantity)::int AS low
         FROM inventory_items i`);
    const mv = await ctx.tx.query<{ ins: number; outs: number }>(
      `SELECT COUNT(*) FILTER (WHERE kind = 'in')::int AS ins, COUNT(*) FILTER (WHERE kind = 'out')::int AS outs
         FROM inventory_movements WHERE created_at >= ${FROM} AND created_at < ${TO}`, p);
    return { activeItems: r.rows[0]!.active, lowStock: r.rows[0]!.low, entries: mv.rows[0]!.ins, exits: mv.rows[0]!.outs };
  } },
];

async function buildOverview(ctx: ClinicCtx, q: { from: string; to: string }) {
  const days = (Date.parse(q.to) - Date.parse(q.from)) / 86400000;
  if (!(days >= 0)) throw badRequest('A data final deve ser igual ou posterior à inicial.');
  if (days > 366) throw badRequest('Período máximo: 366 dias.');
  const sections: Record<string, unknown> = {};
  const omitted: { section: string; reason: string }[] = [];
  const scoped = (await unitScope(ctx)) !== null;
  for (const s of SECTIONS) {
    if (scoped && s.name !== 'appointments') omitted.push({ section: s.name, reason: 'indisponível no escopo por unidade (dados da clínica inteira)' });
    else if (!ctx.entitlements.has(s.cap)) omitted.push({ section: s.name, reason: 'recurso não contratado' });
    else if (!hasPermission(ctx.user.role, s.perm)) omitted.push({ section: s.name, reason: 'seu perfil não tem acesso a esta seção' });
    else sections[s.name] = await s.run(ctx, [q.from, q.to]);
  }
  return { period: q, sections, omitted };
}

// ---------------------------------------------------------------- exportação (CSV)
type Unit = 'qtd' | 'R$' | '%';
interface Row { section: string; indicator: string; value: string | number | null; unit: Unit }
const SECTION_NAME: Record<string, string> = { appointments: 'Atendimentos', patients: 'Pacientes', finance: 'Financeiro', crm: 'CRM', inventory: 'Estoque' };
const STATUS_NAME: Record<string, string> = { completed: 'Concluídas', scheduled: 'Agendadas', confirmed: 'Confirmadas', checked_in: 'Na recepção', called: 'Chamadas', in_service: 'Em atendimento', cancelled: 'Canceladas', no_show: 'Faltas' };
const STAGE_NAME: Record<string, string> = { new: 'Novo', contacted: 'Contatado', qualified: 'Qualificado', scheduled: 'Agendado', won: 'Convertido', lost: 'Perdido' };
const METHOD_NAME: Record<string, string> = { pix: 'Pix', card: 'Cartão', cash: 'Dinheiro' };
const reais = (cents: string) => (Number(BigInt(cents)) / 100).toFixed(2);

/** Achata as seções do relatório em linhas "seção; indicador; valor; unidade". Só agregados, como na tela. */
export function overviewRows(sections: Record<string, any>): Row[] {
  const rows: Row[] = [];
  const add = (section: string, indicator: string, value: string | number | null, unit: Unit) => rows.push({ section: SECTION_NAME[section] ?? section, indicator, value, unit });
  const a = sections.appointments;
  if (a) {
    add('appointments', 'Total de atendimentos', a.total, 'qtd');
    for (const [k, v] of Object.entries(a.byStatus as Record<string, number>)) add('appointments', `Atendimentos ${STATUS_NAME[k] ?? k}`, v, 'qtd');
    add('appointments', 'Taxa de falta', a.noShowRate, '%');
    for (const p of a.byProfessional as { name: string; total: number; completed: number; noShow: number; cancelled: number }[]) {
      add('appointments', `${p.name}: total`, p.total, 'qtd'); add('appointments', `${p.name}: concluídas`, p.completed, 'qtd');
      add('appointments', `${p.name}: faltas`, p.noShow, 'qtd'); add('appointments', `${p.name}: canceladas`, p.cancelled, 'qtd');
    }
  }
  const pa = sections.patients;
  if (pa) { add('patients', 'Pacientes novos', pa.newPatients, 'qtd'); add('patients', 'Pacientes ativos (total)', pa.totalActive, 'qtd'); }
  const f = sections.finance;
  if (f) {
    add('finance', 'Cobrado', reais(f.chargedCents), 'R$'); add('finance', 'Recebido (líquido de estornos)', reais(f.receivedCents), 'R$');
    add('finance', 'Estornado', reais(f.refundedCents), 'R$'); add('finance', 'Descontos aprovados', reais(f.discountsCents), 'R$');
    add('finance', 'Em aberto (todos os pacientes)', reais(f.outstandingCents), 'R$');
    for (const m of f.byMethod as { method: string; receivedCents: string }[]) add('finance', `Recebido em ${METHOD_NAME[m.method] ?? m.method}`, reais(m.receivedCents), 'R$');
    if (f.cash) { add('finance', 'Caixas fechados', f.cash.closedSessions, 'qtd'); add('finance', 'Diferença nos caixas', reais(f.cash.differenceCents), 'R$'); add('finance', 'Descontos aguardando aprovação', f.cash.pendingDiscounts, 'qtd'); }
  }
  const c = sections.crm;
  if (c) {
    add('crm', 'Leads criados', c.created, 'qtd');
    for (const [k, v] of Object.entries(c.byStage as Record<string, number>)) add('crm', `Leads em ${STAGE_NAME[k] ?? k}`, v, 'qtd');
    for (const s of c.bySource as { source: string; n: number; won: number }[]) { add('crm', `Origem ${s.source}: leads`, s.n, 'qtd'); add('crm', `Origem ${s.source}: convertidos`, s.won, 'qtd'); }
    add('crm', 'Taxa de conversão', c.conversionRate, '%');
  }
  const i = sections.inventory;
  if (i) { add('inventory', 'Itens ativos', i.activeItems, 'qtd'); add('inventory', 'Itens no mínimo ou abaixo', i.lowStock, 'qtd'); add('inventory', 'Entradas no período', i.entries, 'qtd'); add('inventory', 'Saídas no período', i.exits, 'qtd'); }
  return rows;
}

/** Célula CSV: aspas quando preciso e proteção contra fórmulas (=, +, -, @) ao abrir em planilha. */
export function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v) : v;
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** CSV para Excel em português: separador ";", decimal com vírgula, BOM UTF-8. */
export function toCsv(period: { from: string; to: string }, rows: Row[]): string {
  const num = (r: Row) => (typeof r.value === 'string' && r.unit === 'R$' ? r.value.replace('.', ',') : r.value);
  const lines = [['Período', `${period.from} a ${period.to}`, '', ''], ['Seção', 'Indicador', 'Valor', 'Unidade'], ...rows.map((r) => [r.section, r.indicator, num(r), r.unit])];
  return '\uFEFF' + lines.map((l) => l.map((c) => csvCell(c as string | number | null)).join(';')).join('\r\n') + '\r\n';
}

export function reportRoutes(app: FastifyInstance) {
  // Só agregados (contagens e somas), nunca dados de uma pessoa. Cada seção respeita o recurso do plano e a permissão do perfil.
  clinicRoute(app, 'GET', '/api/reports/overview', { cap: 'analytics.bi', perm: 'reports.read' }, async (ctx) => {
    const q = z.object({ from: ymd, to: ymd }).parse(ctx.req.query);
    return buildOverview(ctx, q);
  });

  // Exportação dos mesmos indicadores em CSV. Mesmas regras de plano e perfil; a exportação fica no registro de auditoria.
  clinicRoute(app, 'GET', '/api/reports/export', { cap: 'analytics.bi', perm: 'reports.read' }, async (ctx, _req, reply) => {
    const q = z.object({ from: ymd, to: ymd }).parse(ctx.req.query);
    const o = await buildOverview(ctx, q);
    const rows = overviewRows(o.sections as Record<string, any>);
    await audit(ctx, 'report.export', 'report', undefined, { from: q.from, to: q.to, rows: rows.length, omitted: o.omitted.map((x) => x.section) });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="indicadores-${q.from}_${q.to}.csv"`);
    return toCsv(q, rows);
  });
}
