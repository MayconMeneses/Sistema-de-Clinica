import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { get, type Me } from './api';
import { ToastProvider, useHash } from './ui';
import { Login } from './pages/Login';
import { ForgotPassword, ResetPassword } from './pages/PasswordRecovery';

const ClinicShell = lazy(() => import('./pages/ClinicShell').then((m) => ({ default: m.ClinicShell })));
const PortalApp = lazy(() => import('./pages/Portal').then((m) => ({ default: m.PortalApp })));
const MasterApp = lazy(() => import('./pages/Master').then((m) => ({ default: m.MasterApp })));

function ClinicApp({ hash }: { hash: string }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const refresh = useCallback(() => { get<Me>('/api/me').then(setMe, () => setMe(null)); }, []);
  useEffect(() => {
    refresh();
    const expired = () => { sessionStorage.clear(); setMe(null); };
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, [refresh]);

  if (me === undefined) return <main className="auth"><p className="loading" role="status">Carregando…</p></main>;
  if (me === null && hash.startsWith('/redefinir')) return <ResetPassword hash={hash} />;
  if (me === null && hash.startsWith('/esqueci')) return <ForgotPassword />;
  if (me === null) return <Login mode="clinic" onDone={refresh} />;
  return <ClinicShell me={me} hash={hash} onLogout={() => { sessionStorage.clear(); setMe(null); }} onRefresh={refresh} />;
}

export default function App() {
  const [hash] = useHash();
  return (
    <ToastProvider>
      <Suspense fallback={<main className="auth"><p className="loading" role="status">Carregando…</p></main>}>
        {hash.startsWith('/master') ? <MasterApp hash={hash} /> : hash.startsWith('/portal') ? <PortalApp /> : <ClinicApp hash={hash} />}
      </Suspense>
    </ToastProvider>
  );
}
