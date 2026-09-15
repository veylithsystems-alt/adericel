import { useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { SeverityChip } from '../components/State.js';
import { Empty, ErrorNotice, Loading, PageHeader, Section } from '../components/Shell.js';
import { useApi, useMutation } from '../lib/use-api.js';
import { SEVERITY_ORDER, formatInstant, since } from '../lib/assurance-presentation.js';
import type { ActionSummary, Finding, Me } from '../lib/types.js';

/**
 * Fix: findings and the action centre.
 *
 * The two are on one screen because they are one workflow — a finding that
 * nobody can act on is just a complaint, and an action with no finding behind
 * it has no justification.
 */
export function Fix({ me }: { me: Me }): ReactElement {
  const { organisationId } = useParams();
  const findings = useApi<{ findings: Finding[] }>(
    organisationId ? `/v1/organisations/${organisationId}/findings?openOnly=true&limit=100` : null,
  );
  const actions = useApi<{ actions: ActionSummary[] }>(
    organisationId ? `/v1/organisations/${organisationId}/actions?limit=100` : null,
  );

  const canApprove = me.permissions.includes('org:action:approve');
  const canExecute = me.permissions.includes('org:action:execute');

  const decide = useMutation<
    { actionId: string; decision: 'APPROVED' | 'REJECTED'; note?: string },
    { state: string; approvalsRecorded: number; approvalsRequired: number }
  >(({ actionId, decision, note }) => ({
    path: `/v1/organisations/${organisationId}/actions/${actionId}/decision`,
    options: { method: 'POST', body: { decision, ...(note ? { note } : {}) } },
  }));

  const execute = useMutation<string, { state: string; detail: string }>((actionId) => ({
    path: `/v1/organisations/${organisationId}/actions/${actionId}/execute`,
    options: { method: 'POST' },
  }));

  const verify = useMutation<string, { outcome: string; detail: string }>((actionId) => ({
    path: `/v1/organisations/${organisationId}/actions/${actionId}/verify`,
    options: { method: 'POST' },
  }));

  const [note, setNote] = useState('');

  const refresh = (): void => {
    actions.reload();
    findings.reload();
  };

  if (findings.loading || actions.loading) return <Loading what="findings and actions" />;
  if (findings.error) return <ErrorNotice error={findings.error} />;
  if (actions.error) return <ErrorNotice error={actions.error} />;

  const openFindings = [...(findings.data?.findings ?? [])].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.ageDays - a.ageDays,
  );
  const allActions = actions.data?.actions ?? [];
  const awaiting = allActions.filter((a) => a.state === 'AWAITING_APPROVAL');
  const authorised = allActions.filter((a) => a.state === 'AUTHORISED');
  const verifying = allActions.filter((a) => a.state === 'VERIFYING');
  const attention = allActions.filter((a) =>
    ['UNVERIFIED', 'ROLLBACK_REQUIRED', 'FAILED', 'TIMED_OUT'].includes(a.state),
  );
  const history = allActions.filter((a) =>
    ['CONFIRMED', 'REJECTED', 'CANCELLED', 'ROLLED_BACK'].includes(a.state),
  );

  return (
    <>
      <PageHeader
        title="Fix"
        lead="What is wrong, and what Adericel can do about it. Nothing here executes without an explicit decision."
      />

      {awaiting.length > 0 ? (
        <Section
          title="Waiting for a decision"
          note={`${awaiting.length} action${awaiting.length === 1 ? '' : 's'}`}
        >
          <div className="stack">
            {awaiting.map((action) => (
              <div key={action.id} className="panel stack">
                <div className="row row--between">
                  <div>
                    <h3>{action.actionType}</h3>
                    <div className="meta">
                      Target {action.target ?? '—'} · risk{' '}
                      {action.riskClass.toLowerCase().replace(/_/g, ' ')} · autonomy L
                      {action.autonomyLevel ?? '?'}
                    </div>
                  </div>
                  <div className="meta">
                    {action.approvals
                      ? `${action.approvals.recorded} of ${action.approvals.required} approvals`
                      : ''}
                    {action.expiresAt ? ` · expires ${formatInstant(action.expiresAt)}` : ''}
                  </div>
                </div>

                <p>{action.rationale}</p>
                <div className="meta">
                  Proposed by {action.proposedBy}, {since(action.proposedAt)}
                  {action.finding?.title ? ` · for finding "${action.finding.title}"` : ''}
                </div>

                {canApprove ? (
                  <>
                    <div className="field">
                      <label className="field__label" htmlFor={`note-${action.id}`}>
                        Note (recorded in the audit trail)
                      </label>
                      <textarea
                        id={`note-${action.id}`}
                        className="textarea"
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Why you are approving or rejecting this."
                      />
                    </div>
                    <div className="row">
                      <button
                        type="button"
                        className="button"
                        disabled={decide.running}
                        onClick={() => {
                          void decide
                            .run({ actionId: action.id, decision: 'APPROVED', note })
                            .then(() => {
                              setNote('');
                              refresh();
                            });
                        }}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="button button--secondary"
                        disabled={decide.running}
                        onClick={() => {
                          void decide
                            .run({ actionId: action.id, decision: 'REJECTED', note })
                            .then(() => {
                              setNote('');
                              refresh();
                            });
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="notice">
                    You do not hold approval authority for this organisation. Approval is
                    deliberately separated from proposal, so the person who proposed a change cannot
                    also authorise it.
                  </div>
                )}
                {decide.error ? <ErrorNotice error={decide.error} /> : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {authorised.length > 0 && canExecute ? (
        <Section title="Approved, ready to run">
          <div className="stack">
            {authorised.map((action) => (
              <div key={action.id} className="panel row row--between">
                <div>
                  <strong>{action.actionType}</strong>
                  <div className="meta">{action.target} · approved and awaiting execution</div>
                </div>
                <button
                  type="button"
                  className="button"
                  disabled={execute.running}
                  onClick={() => void execute.run(action.id).then(refresh)}
                >
                  {execute.running ? 'Executing…' : 'Execute'}
                </button>
              </div>
            ))}
          </div>
          {execute.error ? <ErrorNotice error={execute.error} /> : null}
        </Section>
      ) : null}

      {verifying.length > 0 ? (
        <Section
          title="Executed, awaiting verification"
          note="Executed is not the same as successful"
        >
          <div className="stack">
            {verifying.map((action) => (
              <div key={action.id} className="panel row row--between">
                <div>
                  <strong>{action.actionType}</strong>
                  <div className="meta">
                    Executed {since(action.executedAt)}. Adericel has not yet confirmed the change
                    took effect.
                  </div>
                </div>
                {canExecute ? (
                  <button
                    type="button"
                    className="button"
                    disabled={verify.running}
                    onClick={() => void verify.run(action.id).then(refresh)}
                  >
                    {verify.running ? 'Verifying…' : 'Verify now'}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {verify.error ? <ErrorNotice error={verify.error} /> : null}
        </Section>
      ) : null}

      {attention.length > 0 ? (
        <Section title="Needs attention">
          <div className="stack">
            {attention.map((action) => (
              <div key={action.id} className="notice notice--failing">
                <div className="notice__title">
                  {action.actionType} — {action.state.replace(/_/g, ' ').toLowerCase()}
                </div>
                <p>
                  {action.state === 'UNVERIFIED'
                    ? 'The action was dispatched but Adericel could not confirm it achieved the intended state. It is not recorded as successful.'
                    : action.state === 'ROLLBACK_REQUIRED'
                      ? 'The outcome is unknown or was refuted. Reconcile against the external system before retrying.'
                      : (action.lastError ?? 'The action did not complete.')}
                </p>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Open findings" note={`${openFindings.length} open`}>
        {openFindings.length === 0 ? (
          <Empty>
            No open findings. Note that this is not the same as everything being proven — check the
            unknown count on the assurance page.
          </Empty>
        ) : (
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Finding</th>
                  <th>Severity</th>
                  <th>Control</th>
                  <th>Open for</th>
                  <th className="table__numeric">Actions</th>
                </tr>
              </thead>
              <tbody>
                {openFindings.map((finding) => (
                  <tr key={finding.id}>
                    <td>
                      <div>{finding.title}</div>
                      <div className="meta">{finding.description}</div>
                    </td>
                    <td>
                      <SeverityChip severity={finding.severity} />
                    </td>
                    <td>
                      {finding.control?.id ? (
                        <Link
                          to={`/organisations/${organisationId}/controls/${finding.control.id}`}
                        >
                          <code className="meta">{finding.control.key}</code>
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="meta">
                      {finding.ageDays} day{finding.ageDays === 1 ? '' : 's'}
                    </td>
                    <td className="table__numeric">{finding.openActions || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {history.length > 0 ? (
        <Section title="Completed actions">
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Outcome</th>
                  <th>Target</th>
                  <th>Verified</th>
                </tr>
              </thead>
              <tbody>
                {history.map((action) => (
                  <tr key={action.id}>
                    <td>
                      <code className="data">{action.actionType}</code>
                    </td>
                    <td className="meta">{action.state.toLowerCase()}</td>
                    <td className="meta">{action.target ?? '—'}</td>
                    <td className="meta">{action.verifiedAt ? since(action.verifiedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}
    </>
  );
}
