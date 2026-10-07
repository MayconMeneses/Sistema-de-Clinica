import { useEffect, useState } from 'react';
import { masterMfaRequired } from './api';

/** true enquanto o servidor exige código MFA do Master (padrão, e sempre em produção). */
export function useMasterMfa(): boolean {
  const [required, setRequired] = useState(true);
  useEffect(() => { void masterMfaRequired().then(setRequired); }, []);
  return required;
}
