import { get } from '../api';
import { Select, useLoad } from '../ui';

/** Escolha da unidade do item/lead. Perfil sem escopo pode deixar "central / sem unidade"; gerente de unidade precisa escolher uma das suas. */
export function UnitPick({ value, onChange, scoped, centralLabel }: { value: string; onChange: (v: string) => void; scoped: boolean; centralLabel: string }) {
  const units = useLoad(() => get<{ units: { id: string; name: string }[] }>('/api/units'), []);
  const list = units.data?.units ?? [];
  if (!scoped && list.length === 0) return null;      // clínica sem unidades cadastradas: nada a escolher
  return (
    <Select label="Unidade" value={value} onChange={onChange}>
      {!scoped && <option value="">{centralLabel}</option>}
      {scoped && !value && <option value="">Escolha a unidade…</option>}
      {list.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
    </Select>
  );
}
