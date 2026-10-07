// Avisa a equipe quando uma tela quebra no navegador. Só envia texto curto do erro e a tela (sem ids); nunca dados digitados.
let sent = 0;
function report(message: string) {
  if (sent++ >= 3) return; // no máximo 3 avisos por aba aberta
  void fetch('/api/telemetry/client-error', {
    method: 'POST', keepalive: true,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'clinica-one' },
    body: JSON.stringify({ message: message.slice(0, 300), page: location.hash.slice(0, 120) }),
  }).catch(() => undefined);
}
export function startErrorReporting(): void {
  window.addEventListener('error', (e) => report(`${e.message || 'Erro de script'}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { name?: string; message?: string; status?: number } | undefined;
    if (r && typeof r.status === 'number') return; // erros esperados da API (ApiError) já aparecem para o usuário
    report(`Promessa rejeitada: ${r?.name ?? ''} ${r?.message ?? ''}`);
  });
}
