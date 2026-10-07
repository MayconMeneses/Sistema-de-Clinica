export type Role = 'owner' | 'admin' | 'unit_manager' | 'receptionist' | 'professional' | 'finance' | 'stock' | 'marketing' | 'auditor';

const CLINICAL_FRONT: Role[] = ['owner', 'admin', 'unit_manager', 'receptionist', 'professional'];

/** RBAC deny-by-default: permissão desconhecida é negada. Segregação: admin/recepção não leem prontuário. */
const PERMISSIONS = {
  'patients.read': CLINICAL_FRONT,
  'patients.write': CLINICAL_FRONT,
  'agenda.read': CLINICAL_FRONT,
  'agenda.write': CLINICAL_FRONT,
  'notes.read': ['owner', 'professional'],
  'notes.write': ['professional'],
  'patients.merge': ['owner', 'admin'],
  'patients.export': ['owner', 'admin'],
  'privacy.open': ['owner', 'admin', 'unit_manager', 'receptionist'],
  'privacy.manage': ['owner', 'admin'],
  'org.manage': ['owner', 'admin'],
  'schedule.manage': ['owner', 'admin', 'unit_manager', 'receptionist'],
  'schedule.override': ['owner', 'admin', 'unit_manager', 'receptionist'],
  'comm.read': ['owner', 'admin', 'unit_manager', 'receptionist'],
  'dental.read': ['owner', 'professional'],
  'dental.write': ['professional'],
  'finance.read': ['owner', 'admin', 'unit_manager', 'receptionist', 'finance', 'auditor'],
  'finance.write': ['owner', 'admin', 'receptionist', 'finance'],
  'cash.operate': ['owner', 'admin', 'receptionist', 'finance'],
  'payments.manage': ['owner', 'admin'],
  'payments.charge': ['owner', 'admin', 'unit_manager', 'receptionist', 'finance'],
  'finance.approve': ['owner', 'admin', 'unit_manager', 'finance'],
  'payables.read': ['owner', 'admin', 'unit_manager', 'finance', 'auditor'],
  'payables.write': ['owner', 'admin', 'finance'],
  'users.manage': ['owner', 'admin'],
  'audit.read': ['owner', 'admin', 'auditor'],
  'inventory.read': ['owner', 'admin', 'unit_manager', 'stock', 'auditor'],
  'inventory.write': ['owner', 'admin', 'unit_manager', 'stock'],
  'crm.read': ['owner', 'admin', 'unit_manager', 'receptionist', 'marketing'],
  'crm.write': ['owner', 'admin', 'unit_manager', 'receptionist', 'marketing'],
  'reports.read': ['owner', 'admin', 'unit_manager', 'finance', 'marketing', 'auditor'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: string, permission: string): boolean {
  const allowed = (PERMISSIONS as Record<string, readonly string[]>)[permission];
  return !!allowed && allowed.includes(role);
}

export function permissionsFor(role: string): string[] {
  return Object.keys(PERMISSIONS).filter((p) => hasPermission(role, p));
}
