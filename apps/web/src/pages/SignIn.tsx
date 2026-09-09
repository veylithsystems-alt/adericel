import { useState, type FormEvent, type ReactElement } from 'react';
import { Mark } from '../components/Mark.js';
import { signIn } from '../lib/api.js';
import type { ApiError } from '../lib/api.js';

export function SignIn(): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (caught) {
      // The API returns one message for every failure mode by design, so the
      // interface must not attempt to be more specific than the server was.
      setError((caught as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <div className="signin__card">
        <div className="signin__wordmark">
          <Mark size={30} />
          <span>Adericel</span>
        </div>
        <div className="signin__tagline">Truth / Evidence / Assurance</div>

        <form className="panel stack" onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label className="field__label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {error ? (
            <div className="notice notice--failing" role="alert">
              {error}
            </div>
          ) : null}

          <button className="button" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
