import type { ReactElement } from 'react';
import { useParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { StateChip } from '../components/State.js';
import { Empty, ErrorNotice, Loading, PageHeader, Section } from '../components/Shell.js';
import { useApi } from '../lib/use-api.js';
import { formatInstant, since, type AssuranceState } from '../lib/assurance-presentation.js';
import type { AuditEntry } from '../lib/types.js';

/**
 * Change: what moved, and why.
 *
 * Assurance changes and the audit trail sit together because the useful
 * question is rarely "what happened?" on its own — it is "what changed, and who
 * or what caused it?".
 */
export function Change(): ReactElement {
  const { organisationId } = useParams();

  const changes = useApi<{
    assessments: {
      id: string;
      subjectKind: string;
      subjectId: string;
      state: AssuranceState;
      unknownReason: string | null;
      rationale: string;
      trigger: string;
      assessedAt: string;
    }[];
  }>(
    organisationId
      ? `/v1/organisations/${organisationId}/assessments?onlyChanges=true&limit=60`
      : null,
  );

  const audit = useApi<{ entries: AuditEntry[] }>(
    organisationId ? `/v1/organisations/${organisationId}/audit?limit=100` : null,
  );

  if (changes.loading) return <Loading what="changes" />;
  if (changes.error) return <ErrorNotice error={changes.error} />;

  const assessments = changes.data?.assessments ?? [];
  const entries = audit.data?.entries ?? [];

  return (
    <>
      <PageHeader
        title="Change"
        lead="Every assurance state change, and the complete record of who did what — including what was refused."
      />

      <Section title="Assurance changes" note="Only assessments where the state moved">
        {assessments.length === 0 ? (
          <Empty>No assurance state has changed yet.</Empty>
        ) : (
          <ul className="timeline">
            {assessments.map((assessment) => (
              <li key={assessment.id} className="timeline__item">
                <span className="timeline__when">{formatInstant(assessment.assessedAt)}</span>
                <span>
                  <div className="row">
                    <StateChip state={assessment.state} reason={assessment.unknownReason} />
                    <span className="meta">
                      {assessment.subjectKind.toLowerCase()} · triggered by{' '}
                      {assessment.trigger.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  </div>
                  <p style={{ marginTop: 'var(--space-1)' }}>{assessment.rationale}</p>
                  {assessment.subjectKind === 'CONTROL' ? (
                    <Link
                      className="meta"
                      to={`/organisations/${organisationId}/controls/${assessment.subjectId}`}
                    >
                      See why
                    </Link>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Audit trail" note="Refusals are recorded with the same weight as successes">
        {entries.length === 0 ? (
          <Empty>No audit entries yet.</Empty>
        ) : (
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Did</th>
                  <th>To</th>
                  <th>Outcome</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="meta">{since(entry.occurredAt)}</td>
                    <td>{entry.actorDisplay}</td>
                    <td>
                      <code className="data">{entry.action}</code>
                    </td>
                    <td className="meta">{entry.resourceType}</td>
                    <td>
                      <span
                        className={`state state--${
                          entry.outcome === 'SUCCESS'
                            ? 'proven'
                            : entry.outcome === 'DENIED'
                              ? 'failing'
                              : 'exception'
                        }`}
                      >
                        <span className="state__dot" aria-hidden="true" />
                        {entry.outcome.toLowerCase()}
                      </span>
                    </td>
                    <td className="meta">{entry.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
