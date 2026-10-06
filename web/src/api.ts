export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown): Promise<T> {
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
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? 'Não foi possível concluir a ação.');
  }
  return data as T;
}

export const get = <T,>(u: string) => api<T>('GET', u);
export const post = <T,>(u: string, b?: unknown) => api<T>('POST', u, b ?? {});
export const patch = <T,>(u: string, b: unknown) => api<T>('PATCH', u, b);

export interface Me {
  user: { id: string; name: string; email: string; role: string };
  clinic: { name: string };
  permissions: string[];
  entitlements: string[];
}
