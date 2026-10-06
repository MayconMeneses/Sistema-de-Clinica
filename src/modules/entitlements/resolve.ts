export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'closed';

export interface CapabilityDef {
  code: string;
  globallyAvailable: boolean;
  dependsOn: string[];
}

export interface EntitlementInput {
  tenantStatus: TenantStatus;
  planCapabilities: string[];
  overrides: { capability: string; mode: 'grant' | 'block' }[];
  catalog: CapabilityDef[];
}

/**
 * Entitlement efetivo (decisão no backend). Ordem de precedência:
 * status do tenant > indisponibilidade global > bloqueio > concessão > plano > dependências.
 * Parcial em relação à spec §6: addons, quotas, flags e política de segurança ainda não modelados.
 */
export function resolveEntitlements(input: EntitlementInput): Set<string> {
  if (input.tenantStatus !== 'active') return new Set();

  const catalog = new Map(input.catalog.map((c) => [c.code, c]));
  const effective = new Set(input.planCapabilities);
  for (const o of input.overrides) if (o.mode === 'grant') effective.add(o.capability);
  for (const o of input.overrides) if (o.mode === 'block') effective.delete(o.capability);

  for (const code of [...effective]) {
    const def = catalog.get(code);
    if (!def || !def.globallyAvailable) effective.delete(code); // desconhecida => negada
  }

  // Remove capabilities cujas dependências não estão presentes, até estabilizar.
  let changed = true;
  while (changed) {
    changed = false;
    for (const code of [...effective]) {
      const deps = catalog.get(code)?.dependsOn ?? [];
      if (deps.some((d) => !effective.has(d))) {
        effective.delete(code);
        changed = true;
      }
    }
  }
  return effective;
}

export function can(entitlements: Set<string>, capability: string): boolean {
  return entitlements.has(capability);
}
