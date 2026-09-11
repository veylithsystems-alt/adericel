import { useState, type FormEvent, type ReactElement } from 'react';
import { Mark } from '../components/Mark.js';
import { completeMfa, signIn } from '../lib/api.js';
import type { ApiError, MfaChallenge } from '../lib/api.js';

export function SignIn(): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await signIn(email, password);
      if (result.kind === 'mfa-required') {
        // Held in component state only. It is not a session and is not stored:
        // closing the tab means starting again from the password.
        setChallenge(result.challenge);
        setPassword('');
      }
    } catch (caught) {
      // The API returns one message for every failure mode by design, so the
      // interface must not attempt to be more specific than the server was.
      setError((caught as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitSecondFactor(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await completeMfa(challenge.challengeToken, useRecovery ? { recoveryCode: code } : { code });
    } catch (caught) {
      setError((caught as ApiError).message);
      // A challenge is burned after five wrong codes, and consumed on success.
      // Rather than leave the user typing into a dead form, send them back to
      // the start — which is where the server has already put them.
      setChallenge(null);
      setCode('');
      setUseRecovery(false);
    } finally {
      setBusy(false);
    }
  }

  if (challenge) {
    return (
      <div className="signin">
        <div className="signin__card">
          <div className="signin__wordmark">
            <Mark size={30} />
            <span>Adericel</span>
          </div>
          <div className="signin__tagline">Second factor</div>

          <form className="panel stack" onSubmit={(event) => void submitSecondFactor(event)}>
            <p className="form-note">
              {useRecovery
                ? 'Enter one of the recovery codes you saved when you enrolled. Each one works once.'
                : 'Enter the six-digit code from your authenticator app.'}
            </p>
            <div className="field">
              <label className="field__label" htmlFor="code">
                {useRecovery ? 'Recovery code' : 'Authentication code'}
              </label>
              <input
                id="code"
                className="input"
                type="text"
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                autoFocus
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>

            {error ? (
              <div className="notice notice--failing" role="alert">
                {error}
              </div>
            ) : null}

            <button className="button" type="submit" disabled={busy}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button
              className="button button--quiet"
              type="button"
              onClick={() => {
                setUseRecovery((previous) => !previous);
                setCode('');
                setError(null);
              }}
            >
              {useRecovery ? 'Use my authenticator app' : 'I have lost my authenticator'}
            </button>
          </form>
        </div>
      </div>
    );
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
