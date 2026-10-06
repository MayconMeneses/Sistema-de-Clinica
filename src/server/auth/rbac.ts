export type Role = 'owner' | 'admin' | 'receptionist' | 'professional' | 'finance';

const CLINICAL_FRONT: Role[] = ['owner', 'admin', 'receptionist', 'professional'];

/** RBAC deny-by-default: permissão desconhecida é negada. Segregação: admin/recepção não leem prontuário. */
const PERMISSIONS = {
  'patients.read': CLINICAL_FRONT,
  'patients.write': CLINICAL_FRONT,
  'agenda.read': CLINICAL_FRONT,
  'agenda.write': CLINICAL_FRONT,
  'notes.read': ['owner', 'professional'],
  'notes.write': ['professional'],
  'comm.read': ['owner', 'admin', 'receptionist'],
  'dental.read': ['owner', 'professional'],
  'dental.write': ['professional'],
  'finance.read': ['owner', 'admin', 'receptionist', 'finance'],
  'finance.write': ['owner', 'admin', 'receptionist', 'finance'],
  'users.manage': ['owner', 'admin'],
  'audit.read': ['owner', 'admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: string, permission: string): boolean {
  const allowed = (PERMISSIONS as Record<string, readonly string[]>)[permission];
  return !!allowed && allowed.includes(role);
}

export function permissionsFor(role: string): string[] {
  return Object.keys(PERMISSIONS).filter((p) => hasPermission(role, p));
}
