import { describe, expect, it } from 'vitest';
import { resolveEntitlements, type CapabilityDef } from '../src/modules/entitlements/resolve.js';

const catalog: CapabilityDef[] = [
  { code: 'patient.registry', globallyAvailable: true, dependsOn: [] },
  { code: 'clinical.record', globallyAvailable: true, dependsOn: ['patient.registry'] },
  { code: 'dental.odontogram', globallyAvailable: true, dependsOn: ['clinical.record'] },
  { code: 'finance.advanced', globallyAvailable: true, dependsOn: [] },
  { code: 'tiss.billing', globallyAvailable: false, dependsOn: ['finance.advanced'] },
];
const base = { tenantStatus: 'active' as const, catalog, overrides: [] };

describe('resolveEntitlements', () => {
  it('concede o que o plano inclui', () => {
    const e = resolveEntitlements({ ...base, planCapabilities: ['patient.registry', 'clinical.record'] });
    expect([...e].sort()).toEqual(['clinical.record', 'patient.registry']);
  });
  it('concessão do Master adiciona capability fora do plano', () => {
    const e = resolveEntitlements({ ...base, planCapabilities: ['finance.advanced'], overrides: [{ capability: 'patient.registry', mode: 'grant' }] });
    expect(e.has('patient.registry')).toBe(true);
  });
  it('bloqueio explícito vence plano e concessão', () => {
    const e = resolveEntitlements({ ...base, planCapabilities: ['patient.registry'], overrides: [{ capability: 'patient.registry', mode: 'grant' }, { capability: 'patient.registry', mode: 'block' }] });
    expect(e.has('patient.registry')).toBe(false);
  });
  it('dependência ausente remove a capability dependente (cascata)', () => {
    const e = resolveEntitlements({ ...base, planCapabilities: ['clinical.record', 'dental.odontogram'] });
    expect(e.size).toBe(0);
  });
  it('bloquear dependência derruba dependentes (downgrade sem acesso indevido)', () => {
    const e = resolveEntitlements({ ...base, planCapabilities: ['patient.registry', 'clinical.record', 'dental.odontogram'], overrides: [{ capability: 'clinical.record', mode: 'block' }] });
    expect([...e]).toEqual(['patient.registry']);
  });
  it('tiss.billing nunca é efetivo, nem por plano nem por concessão', () => {
    const e = resolveEntitlements({ ...base, planCapabilities: ['finance.advanced', 'tiss.billing'], overrides: [{ capability: 'tiss.billing', mode: 'grant' }] });
    expect(e.has('tiss.billing')).toBe(false);
    expect(e.has('finance.advanced')).toBe(true);
  });
  it('capability desconhecida é negada', () => {
    const e = resolveEntitlements({ ...base, planCapabilities: ['inexistente'] });
    expect(e.size).toBe(0);
  });
  it.each(['suspended', 'closed', 'provisioning'] as const)('tenant %s não tem entitlements', (tenantStatus) => {
    const e = resolveEntitlements({ ...base, tenantStatus, planCapabilities: ['patient.registry'] });
    expect(e.size).toBe(0);
  });
});
