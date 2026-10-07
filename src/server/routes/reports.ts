import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clinicRoute, type ClinicCtx } from '../context.js';
import { hasPermission } from '../auth/rbac.js';
import { badRequest } from '../http.js';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const TZ = "'America/Sao_Paulo'";
// Intervalo [início do dia "from", início do dia seguinte a "to") no fuso de São Paulo. Parâmetros: $1 = from, $2 = to.
const FROM = `(($1::date)::timestamp AT TIME ZONE ${TZ})`;
const TO = `((($2::date) + 1)::timestamp AT TIME ZONE ${TZ})`;

type Section = { name: string; cap: string; perm: string; run: (ctx: ClinicCtx, p: [string, string]) => Promise<unknown> };

const SECTIONS: Section[] = [
  { name: 'appointments', cap: 'schedule.core', perm: 'agenda.read', run: async (ctx, p) => {
    const st = await ctx.tx.query<{ status: string; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM appointments WHERE starts_at >= ${FROM} AND starts_at < ${TO} GROUP BY status`, p);
    const by = Object.fromEntries(st.rows.map((r) => [r.status, r.n]));
    const total = st.rows.reduce((a, r) => a + r.n, 0);
    const attended = (by.completed ?? 0), missed = (by.no_show ?? 0);
    const pros = await ctx.tx.query(
      `SELECT u.name, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed,
              COUNT(*) FILTER (WHERE a.status = 'no_show')::int AS "noShow", COUNT(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled
         FROM appointments a JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.professional_id
        WHERE a.starts_at >= ${FROM} AND a.starts_at < ${TO} GROUP BY u.name ORDER BY total DESC, u.name LIMIT 20`, p);
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

export function reportRoutes(app: FastifyInstance) {
  // Só agregados (contagens e somas), nunca dados de uma pessoa. Cada seção respeita o recurso do plano e a permissão do perfil.
  clinicRoute(app, 'GET', '/api/reports/overview', { cap: 'analytics.bi', perm: 'reports.read' }, async (ctx) => {
    const q = z.object({ from: ymd, to: ymd }).parse(ctx.req.query);
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86400000;
    if (!(days >= 0)) throw badRequest('A data final deve ser igual ou posterior à inicial.');
    if (days > 366) throw badRequest('Período máximo: 366 dias.');
    const sections: Record<string, unknown> = {};
    const omitted: { section: string; reason: string }[] = [];
    for (const s of SECTIONS) {
      if (!ctx.entitlements.has(s.cap)) omitted.push({ section: s.name, reason: 'recurso não contratado' });
      else if (!hasPermission(ctx.user.role, s.perm)) omitted.push({ section: s.name, reason: 'seu perfil não tem acesso a esta seção' });
      else sections[s.name] = await s.run(ctx, [q.from, q.to]);
    }
    return { period: q, sections, omitted };
  });
}
