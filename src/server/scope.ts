import type { ClinicCtx } from './context.js';
import { forbidden, notFound } from './http.js';

/**
 * Escopo por unidade. Só o perfil `unit_manager` é restrito: enxerga e altera a agenda das unidades a que está vinculado
 * (tabela user_units). Os demais perfis não têm escopo (null). Gerente sem unidade vinculada não enxerga nada (nega por padrão).
 * Unidade de uma consulta = unidade da sala; sem sala, as unidades do profissional.
 */
const cache = new WeakMap<ClinicCtx, string[] | null>();

export async function unitScope(ctx: ClinicCtx): Promise<string[] | null> {
  if (ctx.user.role !== 'unit_manager') return null;
  const hit = cache.get(ctx);
  if (hit !== undefined) return hit;
  const r = await ctx.tx.query<{ unit_id: string }>('SELECT unit_id FROM user_units WHERE user_id = $1', [ctx.user.id]);
  const ids = r.rows.map((x) => x.unit_id);
  cache.set(ctx, ids);
  return ids;
}

/** Condição SQL: a consulta (alias `a`) está no escopo. `p` é o número do parâmetro que recebe uuid[] (ou null = sem restrição). */
export const apptInScope = (p: number, alias = 'a') =>
  `($${p}::uuid[] IS NULL
    OR EXISTS (SELECT 1 FROM resources rs WHERE rs.tenant_id = ${alias}.tenant_id AND rs.id = ${alias}.resource_id AND rs.unit_id = ANY($${p}::uuid[]))
    OR (${alias}.resource_id IS NULL AND EXISTS (SELECT 1 FROM user_units uu WHERE uu.tenant_id = ${alias}.tenant_id AND uu.user_id = ${alias}.professional_id AND uu.unit_id = ANY($${p}::uuid[]))))`;

/** Condição SQL: o usuário (profissional) em `col` compartilha alguma unidade do escopo. */
export const proInScopeSql = (col: string, p: number) =>
  `($${p}::uuid[] IS NULL OR EXISTS (SELECT 1 FROM user_units uu WHERE uu.user_id = ${col} AND uu.unit_id = ANY($${p}::uuid[])))`;

export async function proInScope(ctx: ClinicCtx, professionalId: string): Promise<boolean> {
  const scope = await unitScope(ctx);
  if (scope === null) return true;
  const r = await ctx.tx.query('SELECT 1 FROM user_units WHERE user_id = $1 AND unit_id = ANY($2::uuid[])', [professionalId, scope]);
  return (r.rowCount ?? 0) > 0;
}
export async function resourceInScope(ctx: ClinicCtx, resourceId: string): Promise<boolean> {
  const scope = await unitScope(ctx);
  if (scope === null) return true;
  const r = await ctx.tx.query('SELECT 1 FROM resources WHERE id = $1 AND unit_id = ANY($2::uuid[])', [resourceId, scope]);
  return (r.rowCount ?? 0) > 0;
}

/** Agendar/alterar: a sala (se houver) ou, sem sala, o profissional precisam estar nas unidades do gerente. */
export async function assertBookable(ctx: ClinicCtx, professionalId: string, resourceId: string | null | undefined) {
  if ((await unitScope(ctx)) === null) return;
  const ok = resourceId ? await resourceInScope(ctx, resourceId) : await proInScope(ctx, professionalId);
  if (!ok) throw forbidden('Isto é de outra unidade: seu perfil só gerencia as unidades a que está vinculado.');
}

/** A consulta precisa estar no escopo; fora dele ela "não existe" para o gerente. */
export async function assertApptVisible(ctx: ClinicCtx, id: string) {
  const scope = await unitScope(ctx);
  if (scope === null) return;
  const r = await ctx.tx.query(`SELECT 1 FROM appointments a WHERE a.id = $1 AND ${apptInScope(2)}`, [id, scope]);
  if (!r.rowCount) throw notFound('Agendamento não encontrado.');
}

// ---------------------------------------------------------------- pacientes, estoque e CRM no escopo da unidade
/**
 * Decisão de produto: o paciente "pertence" à unidade em que tem consulta (ou foi cadastrado pelo próprio gerente). Gerente de
 * unidade enxerga só esses pacientes e tudo que depende deles (documentos, formulários, financeiro do paciente, mensagens...).
 * Dados da clínica inteira (caixa, contas a pagar, compras, inventário geral) não existem por unidade: ficam fora do alcance dele.
 * Estoque e leads têm unidade própria (unit_id): o gerente vê os da sua unidade (e o estoque central, só para consulta).
 */
export const PATIENT_VISIBLE_SQL = (col: string, scopeP: number, meP: number) =>
  `($${scopeP}::uuid[] IS NULL
    OR EXISTS (SELECT 1 FROM patients vp WHERE vp.id = ${col} AND vp.created_by = $${meP})
    OR EXISTS (SELECT 1 FROM appointments va
                WHERE (va.patient_id = ${col} OR va.patient_id IN (SELECT m.id FROM patients m WHERE m.merged_into = ${col} OR m.id = (SELECT mi.merged_into FROM patients mi WHERE mi.id = ${col})))
                  AND ${apptInScope(scopeP, 'va')}))`;

/** O paciente precisa estar no escopo; fora dele ele "não existe" para o gerente. */
export async function assertPatientVisible(ctx: ClinicCtx, patientId: string) {
  const scope = await unitScope(ctx);
  if (scope === null) return;
  const r = await ctx.tx.query(`SELECT 1 FROM patients p WHERE p.id = $1 AND ${PATIENT_VISIBLE_SQL('p.id', 2, 3)}`, [patientId, scope, ctx.user.id]);
  if (!r.rowCount) throw notFound('Paciente não encontrado.');
}

export async function assertUnitInScope(ctx: ClinicCtx, unitId: string | null | undefined) {
  const scope = await unitScope(ctx);
  if (scope === null) return;
  if (!unitId || !scope.includes(unitId)) throw forbidden('Isto é de outra unidade: seu perfil só gerencia as unidades a que está vinculado.');
}

export const denyIfScoped = async (ctx: ClinicCtx, what = 'Esta área reúne dados da clínica inteira') => {
  if ((await unitScope(ctx)) !== null) throw forbidden(`${what} e não está disponível para o gerente de unidade.`);
};
