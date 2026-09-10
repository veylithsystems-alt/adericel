import { StrictMode, useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
// Bundled brand faces. Only the weights the brand pack specifies — Inter at
// 400/500/600 and Plex Mono at 400/500 — because every extra weight is a file
// a customer's browser downloads to render text that never uses it.
import '@fontsource-variable/inter';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/app.css';
import { Shell } from './components/Shell.js';
import { ErrorNotice, Loading } from './components/Shell.js';
import { SignIn } from './pages/SignIn.js';
import { Portfolio } from './pages/Portfolio.js';
import { Account } from './pages/Account.js';
import { Assurance } from './pages/Assurance.js';
import { ControlExplanation } from './pages/ControlExplanation.js';
import { Fix } from './pages/Fix.js';
import { Proof } from './pages/Proof.js';
import { Change } from './pages/Change.js';
import { Ask } from './pages/Ask.js';
import { api, isSignedIn, onAuthChange, restoreSession, type ApiError } from './lib/api.js';
import type { Me } from './lib/types.js';

function App(): ReactElement {
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(!isSignedIn());

  useEffect(() => onAuthChange(setSignedIn), []);

  // A page refresh should not sign an operator out mid-investigation. The
  // stored refresh token is exchanged once on load; a stale one just fails.
  useEffect(() => {
    if (isSignedIn()) {
      setRestoring(false);
      return;
    }
    void restoreSession().finally(() => setRestoring(false));
  }, []);

  useEffect(() => {
    if (!signedIn) {
      setMe(null);
      return;
    }
    setLoading(true);
    api<Me>('/v1/auth/me')
      .then((result) => {
        setMe(result);
        setError(null);
      })
      .catch((caught: unknown) => setError(caught as ApiError))
      .finally(() => setLoading(false));
  }, [signedIn]);

  if (restoring) return <Loading what="your session" />;
  if (!signedIn) return <SignIn />;
  if (loading) return <Loading what="your account" />;
  if (error) return <ErrorNotice error={error} />;
  if (!me) return <Loading what="your account" />;

  return (
    <Routes>
      <Route path="/" element={<ShellRoute me={me} />}>
        <Route index element={<Portfolio me={me} />} />
        <Route path="account" element={<Account />} />
      </Route>
      <Route path="/organisations/:organisationId" element={<ShellRoute me={me} />}>
        <Route index element={<Assurance />} />
        <Route path="controls/:controlId" element={<ControlExplanation />} />
        <Route path="fix" element={<Fix me={me} />} />
        <Route path="proof" element={<Proof />} />
        <Route path="change" element={<Change />} />
        <Route path="ask" element={<Ask />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * The shell reads route params to know which organisation is active, so it is
 * mounted as a layout route rather than wrapping the router.
 */
function ShellRoute({ me }: { me: Me }): ReactElement {
  return (
    <Shell me={me}>
      <Outlet />
    </Shell>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
