import { useState, type FormEvent, type ReactElement } from 'react';
import { PageHeader, Section } from '../components/Shell.js';
import { api } from '../lib/api.js';
import { useApi } from '../lib/use-api.js';
import type { ApiError } from '../lib/api.js';

/**
 * Account security.
 *
 * The page has one job: get a second factor onto the account, and be honest
 * about what is not protected until it is. The wording is deliberately about
 * consequence rather than compliance — "you cannot approve" is a fact the
 * person can act on; "MFA is recommended" is not.
 */

interface MfaStatus {
  readonly enrolled: boolean;
  readonly pendingEnrolment: boolean;
  readonly label: string | null;
  readonly enrolledAt: string | null;
  readonly recoveryCodesRemaining: number;
  readonly sessionSatisfied: boolean;
  readonly requiredFor: readonly string[];
}

interface EnrolmentStart {
  readonly secret: string;
  readonly provisioningUri: string;
}

export function Account(): ReactElement {
  const status = useApi<MfaStatus>('/v1/auth/mfa');
  const [enrolment, setEnrolment] = useState<EnrolmentStart | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setEnrolment(await api<EnrolmentStart>('/v1/auth/mfa/totp', { method: 'POST' }));
    } catch (caught) {
      setError((caught as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ recoveryCodes: string[] }>('/v1/auth/mfa/totp/confirm', {
        method: 'POST',
        body: { code },
      });
      setRecoveryCodes(result.recoveryCodes);
      setEnrolment(null);
      setCode('');
      status.reload();
    } catch (caught) {
      setError((caught as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/mfa/totp', { method: 'DELETE', body: { code } });
      setCode('');
      setRecoveryCodes(null);
      status.reload();
    } catch (caught) {
      setError((caught as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (status.loading) return <p className="form-note">Loading…</p>;
  if (status.error || !status.data) {
    return (
      <div className="notice notice--failing" role="alert">
        {status.error?.message ?? 'Could not load account security.'}
      </div>
    );
  }

  const mfa = status.data;

  return (
    <>
      <PageHeader
        title="Account security"
        lead="Adericel assesses other organisations' authentication. It applies the same standard to itself."
      />

      {error ? (
        <div className="notice notice--failing" role="alert">
          {error}
        </div>
      ) : null}

      {/* Shown once, immediately after enrolment. There is no endpoint that
          returns these again — a recovery code readable from a live session is
          not a recovery code. */}
      {recoveryCodes ? (
        <Section
          title="Save these recovery codes now"
          note="They are shown once and cannot be retrieved. Each one works exactly once, and they are the only way back in if you lose your authenticator."
        >
          <div className="recovery-codes">
            {recoveryCodes.map((recoveryCode) => (
              <code key={recoveryCode}>{recoveryCode}</code>
            ))}
          </div>
          <button
            className="button button--small"
            type="button"
            onClick={() => setRecoveryCodes(null)}
          >
            I have saved them
          </button>
        </Section>
      ) : null}

      <Section
        title="Two-factor authentication"
        note={
          mfa.enrolled
            ? `Enrolled${mfa.enrolledAt ? ` on ${new Date(mfa.enrolledAt).toLocaleDateString('en-GB')}` : ''}.`
            : 'Not enrolled.'
        }
      >
        {mfa.enrolled ? (
          <>
            <p className="form-note">
              {mfa.recoveryCodesRemaining} recovery code
              {mfa.recoveryCodesRemaining === 1 ? '' : 's'} remaining.
              {mfa.sessionSatisfied
                ? ' This session presented your second factor, so approvals are available.'
                : ' This session has not presented your second factor. Sign in again to approve anything.'}
            </p>
            <form className="stack" onSubmit={(event) => void remove(event)}>
              <p className="form-note">
                Removing your authenticator needs a current code, not just this session — otherwise
                anyone who took over the session could quietly remove the control that would have
                stopped them.
              </p>
              <div className="field">
                <label className="field__label" htmlFor="remove-code">
                  Authentication code
                </label>
                <input
                  id="remove-code"
                  className="input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
              <button className="button button--danger button--small" type="submit" disabled={busy}>
                Remove authenticator
              </button>
            </form>
          </>
        ) : enrolment ? (
          <form className="stack" onSubmit={(event) => void confirm(event)}>
            <p className="form-note">
              Add this key to your authenticator app, then enter the code it shows. Until you do,
              nothing has changed — an unconfirmed factor cannot sign anyone in.
            </p>
            <div className="field">
              <span className="field__label">Setup key</span>
              <code className="setup-key">{enrolment.secret}</code>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="confirm-code">
                Code from your app
              </label>
              <input
                id="confirm-code"
                className="input"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            <button className="button" type="submit" disabled={busy}>
              {busy ? 'Confirming…' : 'Confirm'}
            </button>
          </form>
        ) : (
          <>
            <div className="notice notice--unknown">
              <div className="notice__title">Approvals are unavailable without a second factor</div>
              <p className="form-note">
                Four-eyes control backed by one credential is one password away from being one pair
                of eyes. Until you enrol, you can propose changes and read everything — you cannot
                approve.
              </p>
            </div>
            <ul className="form-note">
              {mfa.requiredFor.map((permission) => (
                <li key={permission}>
                  <code>{permission}</code>
                </li>
              ))}
            </ul>
            <button className="button" type="button" onClick={() => void begin()} disabled={busy}>
              {busy ? 'Preparing…' : 'Set up authenticator'}
            </button>
          </>
        )}
      </Section>
    </>
  );
}
