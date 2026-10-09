import type { ClinicCtx } from './context.js';
import { forbidden, notFound } from './http.js';
import { assertPatientVisible, denyIfScoped, unitScope } from './scope.js';

/**
 * Política de escopo por unidade para cada rota que o gerente de unidade alcança. Deny-by-default: uma rota que ele alcança e
 * não está aqui é recusada (e o teste `unit-scope-policy` falha ao criar rota nova sem classificar).
 *  open        não toca dado por unidade (cadastros gerais, a própria conta)
 *  handled     a própria rota filtra/valida pelo escopo
 *  deny        dado da clínica inteira
 *  patient     :id da URL é um paciente
 *  body:<campo> o corpo traz o paciente
 *  via:<tabela> :id da URL é um objeto ligado a um paciente (a tabela diz qual)
 */
export type ScopeRule = 'open' | 'handled' | 'deny' | 'patient' | `body:${string}` | `via:${'patient_documents' | 'form_requests' | 'financial_movements' | 'payment_intents' | 'portal_requests' | 'discount_requests' | 'waitlist_entries'}`;

export const SCOPE_POLICY: Record<string, ScopeRule> = {
  // conta e cadastros gerais
  'POST /api/auth/logout': 'open', 'GET /api/me': 'open', 'POST /api/me/password': 'open', 'POST /api/me/mfa/setup': 'open', 'POST /api/me/mfa/enable': 'open', 'POST /api/me/mfa/disable': 'open',
  'GET /api/dashboard': 'handled', 'GET /api/form-templates': 'open',
  'GET /api/professionals': 'handled', 'GET /api/units': 'handled', 'GET /api/resources': 'handled', 'GET /api/availability': 'handled', 'POST /api/availability': 'handled', 'DELETE /api/availability/:id': 'handled',
  'GET /api/blocks': 'handled', 'POST /api/blocks': 'handled', 'DELETE /api/blocks/:id': 'handled',
  // agenda (já tinha escopo próprio)
  'GET /api/appointments': 'handled', 'GET /api/appointments/summary': 'handled', 'POST /api/appointments': 'body:patientId', 'POST /api/appointments/series': 'body:patientId', 'PATCH /api/appointments/:id': 'handled',
  'GET /api/waitlist': 'handled', 'POST /api/waitlist': 'body:patientId', 'PATCH /api/waitlist/:id': 'via:waitlist_entries', 'GET /api/reception': 'handled',
  // pacientes e o que depende deles
  'GET /api/patients': 'handled', 'POST /api/patients': 'handled', 'GET /api/patients/:id': 'patient', 'PATCH /api/patients/:id': 'patient',
  'GET /api/patients/:id/guardians': 'patient', 'POST /api/patients/:id/guardians': 'patient', 'DELETE /api/patients/:id/guardians/:gid': 'patient',
  'GET /api/patients/:id/consents': 'patient', 'POST /api/patients/:id/consents': 'patient',
  'GET /api/patients/:id/privacy': 'patient', 'POST /api/patients/:id/privacy': 'patient',
  'GET /api/patients/:id/documents': 'patient', 'POST /api/patients/:id/documents': 'patient',
  'GET /api/documents/:id/download': 'via:patient_documents', 'GET /api/documents/:id/thumb': 'via:patient_documents', 'GET /api/documents/:id/image': 'via:patient_documents',
  'POST /api/documents/:id/archive': 'via:patient_documents', 'POST /api/documents/:id/share': 'via:patient_documents',
  'POST /api/patients/:id/portal-invite': 'patient', 'GET /api/patients/:id/portal-status': 'patient', 'POST /api/patients/:id/portal-revoke': 'patient',
  'GET /api/portal-booking': 'deny', 'PUT /api/portal-booking': 'deny',
  'GET /api/portal-requests': 'handled', 'POST /api/portal-requests/:id/resolve': 'via:portal_requests',
  'POST /api/patients/:id/forms': 'patient', 'GET /api/patients/:id/forms': 'patient', 'GET /api/forms/:id': 'via:form_requests', 'POST /api/forms/:id/submit': 'via:form_requests', 'POST /api/forms/:id/cancel': 'via:form_requests',
  'POST /api/patients/:id/triage': 'patient',
  'GET /api/patients/:id/finance': 'patient', 'GET /api/finance/movements/:id/receipt': 'via:financial_movements',
  'GET /api/patients/:id/messages': 'patient',
  'POST /api/payments/intents': 'body:patientId', 'GET /api/payments/intents': 'handled', 'POST /api/payments/intents/:id/sync': 'via:payment_intents', 'POST /api/payments/intents/:id/cancel': 'via:payment_intents',
  'POST /api/payments/intents/:id/refund': 'via:payment_intents', 'POST /api/payments/intents/:id/sandbox-approve': 'via:payment_intents',
  'GET /api/finance/discount-requests': 'handled', 'POST /api/finance/discount-requests/:id/decide': 'via:discount_requests',
  // da clínica inteira
  'GET /api/finance/summary': 'deny', 'GET /api/cash/current': 'deny', 'GET /api/cash/sessions': 'deny', 'GET /api/cash/sessions/:id': 'deny', 'GET /api/payables': 'deny',
  'GET /api/suppliers': 'deny', 'POST /api/suppliers': 'deny', 'PATCH /api/suppliers/:id': 'deny',
  'GET /api/purchase-orders': 'deny', 'GET /api/purchase-orders/:id': 'deny', 'POST /api/purchase-orders': 'deny', 'PUT /api/purchase-orders/:id': 'deny',
  'POST /api/purchase-orders/:id/send': 'deny', 'POST /api/purchase-orders/:id/receive': 'deny', 'POST /api/purchase-orders/:id/close': 'deny', 'POST /api/purchase-orders/:id/cancel': 'deny',
  'GET /api/inventory/counts': 'deny', 'POST /api/inventory/counts': 'deny', 'GET /api/inventory/counts/:id': 'deny', 'PUT /api/inventory/counts/:id/lines/:itemId': 'deny',
  'POST /api/inventory/counts/:id/close': 'deny', 'POST /api/inventory/counts/:id/cancel': 'deny',
  'PUT /api/inventory/procedure-supplies': 'deny', 'DELETE /api/inventory/procedure-supplies/:id': 'deny', 'GET /api/inventory/procedure-supplies': 'open',
  'GET /api/inventory/shortages': 'deny', 'POST /api/inventory/shortages/:planItemId/:itemId/resolve': 'deny',
  // estoque e CRM por unidade
  'GET /api/inventory/items': 'handled', 'POST /api/inventory/items': 'handled', 'PATCH /api/inventory/items/:id': 'handled', 'POST /api/inventory/movements': 'handled',
  'GET /api/inventory/items/:id/lots': 'handled', 'GET /api/inventory/items/:id/movements': 'handled',
  'GET /api/crm/leads': 'handled', 'POST /api/crm/leads': 'handled', 'GET /api/crm/leads/:id': 'handled', 'PATCH /api/crm/leads/:id': 'handled', 'POST /api/crm/leads/:id/notes': 'handled',
  'POST /api/crm/leads/:id/convert': 'handled', 'POST /api/crm/leads/:id/schedule': 'handled',
  'GET /api/reports/overview': 'handled', 'GET /api/reports/export': 'handled', 'GET /api/reports/compare': 'handled',
  'GET /api/billing': 'deny', 'GET /api/support-grants': 'deny', 'POST /api/support-grants': 'deny', 'POST /api/support-grants/:id/revoke': 'deny',
};

const VIA_SQL: Record<string, string> = {
  patient_documents: 'SELECT patient_id FROM patient_documents WHERE id = $1',
  form_requests: 'SELECT patient_id FROM form_requests WHERE id = $1',
  financial_movements: 'SELECT patient_id FROM financial_movements WHERE id = $1',
  payment_intents: 'SELECT patient_id FROM payment_intents WHERE id = $1',
  portal_requests: 'SELECT patient_id FROM portal_requests WHERE id = $1',
  discount_requests: 'SELECT patient_id FROM discount_requests WHERE id = $1',
  waitlist_entries: 'SELECT patient_id FROM waitlist_entries WHERE id = $1',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roda antes do handler de qualquer rota da clínica. Só age para perfil com escopo (gerente de unidade). */
export async function enforceUnitScope(ctx: ClinicCtx, method: string, url: string) {
  if ((await unitScope(ctx)) === null) return;
  const rule = SCOPE_POLICY[`${method} ${url}`];
  if (!rule) throw forbidden('Esta área não está disponível para o gerente de unidade.');
  if (rule === 'open' || rule === 'handled') return;
  if (rule === 'deny') return denyIfScoped(ctx);
  const params = (ctx.req.params ?? {}) as Record<string, string>;
  const gate = async (id: unknown, notFoundMsg: string) => {
    if (typeof id !== 'string' || !UUID.test(id)) return;            // id inválido: a validação da própria rota responde 400/404
    try { await assertPatientVisible(ctx, id); } catch { throw notFound(notFoundMsg); }
  };
  if (rule === 'patient') return gate(params.id, 'Paciente não encontrado.');
  if (rule.startsWith('body:')) return gate((ctx.req.body as Record<string, unknown> | undefined)?.[rule.slice(5)], 'Paciente não encontrado.');
  if (rule.startsWith('via:')) {
    const id = params.id;
    if (typeof id !== 'string' || !UUID.test(id)) return;
    const r = await ctx.tx.query<{ patient_id: string | null }>(VIA_SQL[rule.slice(4)]!, [id]);
    if (r.rows[0]?.patient_id) await gate(r.rows[0].patient_id, 'Registro não encontrado.');
  }
}
