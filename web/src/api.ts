export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public data: Record<string, unknown> = {}) { super(message); }
}

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'clinica-one', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'Sem conexão com o servidor. Verifique sua internet e tente novamente.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !url.includes('/login')) window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? 'Não foi possível concluir a ação.', data);
  }
  return data as T;
}

export const get = <T,>(u: string) => api<T>('GET', u);
export const post = <T,>(u: string, b?: unknown) => api<T>('POST', u, b ?? {});
export const patch = <T,>(u: string, b: unknown) => api<T>('PATCH', u, b);
export const del = <T,>(u: string) => api<T>('DELETE', u);

export interface Me {
  user: { id: string; name: string; email: string; role: string };
  clinic: { name: string };
  permissions: string[];
  entitlements: string[];
  mfaEnabled: boolean;
}

/** O servidor de demonstração pode dispensar o código MFA do Master (DEMO_SKIP_MASTER_MFA). */
let mfaRequiredCache: Promise<boolean> | null = null;
export const masterMfaRequired = () => (mfaRequiredCache ??= get<{ mfaRequired: boolean }>('/api/master/auth-info').then((r) => r.mfaRequired).catch(() => true));
