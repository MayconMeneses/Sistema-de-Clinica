/**
 * Papéis da plataforma (Painel Master). Deny-by-default: toda rota master precisa de uma permissão em MASTER_ROUTE_PERMS,
 * senão o servidor nem sobe. Quem faz o quê:
 *  - admin     gerencia operadores e tudo o mais
 *  - clinics   gerência de clínicas: cadastro, plano, situação, funcionalidades, 2 etapas do proprietário
 *  - billing   cobrança: preços, faturas, baixa, inadimplência
 *  - support   suporte: abre o acesso liberado pela clínica, vê e reprocessa integrações
 *  - auditor   somente leitura (visão geral, cobrança, integrações, auditoria)
 */
export const MASTER_ROLES = ['admin', 'clinics', 'billing', 'support', 'auditor'] as const;
export type MasterRole = (typeof MASTER_ROLES)[number];

export const MASTER_ROLE_LABEL: Record<MasterRole, string> = {
  admin: 'Administrador da plataforma', clinics: 'Gerência de clínicas', billing: 'Cobrança', support: 'Suporte', auditor: 'Auditor (leitura)',
};

const MASTER_PERMISSIONS = {
  self: MASTER_ROLES,
  'overview.read': MASTER_ROLES,
  'audit.read': ['admin', 'auditor', 'clinics', 'billing'],
  'clinics.manage': ['admin', 'clinics'],
  'billing.read': ['admin', 'billing', 'clinics', 'auditor'],
  'billing.manage': ['admin', 'billing'],
  'support.open': ['admin', 'support'],
  'integrations.read': ['admin', 'support', 'clinics', 'auditor'],
  'integrations.manage': ['admin', 'support'],
  'alerts.read': ['admin', 'support', 'auditor'],
  'alerts.test': ['admin'],
  'operators.manage': ['admin'],
} as const satisfies Record<string, readonly MasterRole[]>;
export type MasterPermission = keyof typeof MASTER_PERMISSIONS;

export const masterCan = (role: string, perm: MasterPermission) => (MASTER_PERMISSIONS[perm] as readonly string[]).includes(role);
export const masterPermissionsFor = (role: string) => (Object.keys(MASTER_PERMISSIONS) as MasterPermission[]).filter((p) => masterCan(role, p));

/** `MÉTODO url` → permissão. Rota master sem entrada aqui é erro de programação (falha na subida). */
export const MASTER_ROUTE_PERMS: Record<string, MasterPermission> = {
  'POST /api/master/logout': 'self',
  'GET /api/master/me': 'self',
  'GET /api/master/overview': 'overview.read',
  'GET /api/master/audit': 'audit.read',
  'POST /api/master/tenants': 'clinics.manage',
  'PATCH /api/master/tenants/:id': 'clinics.manage',
  'POST /api/master/tenants/:id/reset-owner-mfa': 'clinics.manage',
  'POST /api/master/tenants/:id/overrides': 'clinics.manage',
  'GET /api/master/integrations': 'integrations.read',
  'POST /api/master/tenants/:id/integrations': 'integrations.manage',
  'POST /api/master/integrations/requeue': 'integrations.manage',
  'GET /api/master/alerts': 'alerts.read',
  'POST /api/master/alerts/test': 'alerts.test',
  'GET /api/master/billing': 'billing.read',
  'PATCH /api/master/plans/:code': 'billing.manage',
  'PATCH /api/master/tenants/:id/billing': 'billing.manage',
  'POST /api/master/billing/generate': 'billing.manage',
  'POST /api/master/billing/run': 'billing.manage',
  'POST /api/master/invoices/:id/pay': 'billing.manage',
  'POST /api/master/invoices/:id/void': 'billing.manage',
  'GET /api/master/support': 'support.open',
  'POST /api/master/tenants/:id/support/open': 'support.open',
  'GET /api/master/operators': 'operators.manage',
  'POST /api/master/operators': 'operators.manage',
  'PATCH /api/master/operators/:id': 'operators.manage',
};
