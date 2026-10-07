// Atualização automática do app aberto/instalado (PWA): consulta a versão do servidor e recarrega quando mudar.
const INTERVAL_MS = 60_000;

async function currentVersion(): Promise<string | null> {
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    return r.ok ? ((await r.json()) as { version: string }).version : null;
  } catch { return null; }
}

function typing(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable);
}

export function startAutoUpdate(): void {
  let known: string | null = null;
  const check = async () => {
    const v = await currentVersion();
    if (!v || v === 'dev') return;
    if (known === null) { known = v; return; }
    // Não recarrega no meio da digitação para não perder o que a pessoa está preenchendo; tenta de novo no próximo ciclo.
    if (v !== known && !typing()) location.reload();
  };
  void check();
  setInterval(() => { if (!document.hidden) void check(); }, INTERVAL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
}
