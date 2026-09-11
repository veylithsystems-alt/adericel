import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CountBar, Metric, StateChip } from '../components/State.js';
import { Empty, ErrorNotice, Loading, PageHeader, Section } from '../components/Shell.js';
import { useApi, useMutation } from '../lib/use-api.js';
import {
  STATE_ORDER,
  UNKNOWN_REASON_TEXT,
  since,
  type AssuranceState,
} from '../lib/assurance-presentation.js';
import type { AssuranceSummary } from '../lib/types.js';

/**
 * Organisation assurance.
 *
 * The headline is a state and a set of counts, never a score. Where a
 * proportion appears it is written with its denominator, so a reader cannot
 * mistake "18 of 25 proven" for a mark out of a hundred.
 */
export function Assurance(): ReactElement {
  const { organisationId } = useParams();
  const assurance = useApi<AssuranceSummary>(
    organisationId ? `/v1/organisations/${organisationId}/assurance` : null,
  );
  const organisation = useApi<{ name: string; status: string }>(
    organisationId ? `/v1/organisations/${organisationId}` : null,
  );

  const reassess = useMutation<void, { controlsAssessed: number; statesChanged: number }>(() => ({
    path: `/v1/organisations/${organisationId}/assessments/run-all`,
    options: { method: 'POST' },
  }));

  if (assurance.loading) return <Loading what="assurance state" />;
  if (assurance.error) return <ErrorNotice error={assurance.error} />;
  if (!assurance.data) return <Empty>No assurance data.</Empty>;

  const data = assurance.data;
  const determinate = data.inScope - data.counts.UNKNOWN;
  const proven = data.counts.SATISFIED + data.counts.EXCEPTED;

  const controls = [...data.controls].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.key.localeCompare(b.key),
  );

  return (
    <>
      <PageHeader
        title={organisation.data?.name ?? 'Organisation'}
        lead={
          data.counts.UNKNOWN > 0
            ? `Adericel can speak to ${determinate} of ${data.inScope} in-scope controls. The remaining ${data.counts.UNKNOWN} are unknown — not passing, and not failing.`
            : `Adericel can speak to all ${data.inScope} in-scope controls.`
        }
        actions={
          <button
            type="button"
            className="button button--secondary"
            disabled={reassess.running}
            onClick={() => {
              void reassess.run().then(() => assurance.reload());
            }}
          >
            {reassess.running ? 'Reassessing…' : 'Reassess now'}
          </button>
        }
      />

      <Section title="Current state">
        <div className="panel stack">
          <div className="row row--between">
            <div className="row">
              <StateChip state={data.state} />
              <span className="meta">
                Rolled up from {data.inScope} in-scope control{data.inScope === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <CountBar counts={data.counts} />
          <div className="grid grid--4">
            <Metric
              value={proven}
              label="Proven"
              note={`of ${data.inScope} in scope`}
              tone="proven"
            />
            <Metric
              value={data.counts.NOT_SATISFIED}
              label="Failing"
              tone={data.counts.NOT_SATISFIED > 0 ? 'failing' : undefined}
            />
            <Metric
              value={data.counts.UNKNOWN}
              label="Unknown"
              tone={data.counts.UNKNOWN > 0 ? 'unknown' : undefined}
              note="Insufficient evidence to say"
            />
            <Metric value={data.counts.EXCEPTED} label="Excepted" note="Authorised deviations" />
          </div>
        </div>
      </Section>

      {data.counts.UNKNOWN > 0 ? (
        <div className="notice notice--unknown" style={{ marginBottom: 'var(--space-6)' }}>
          <div className="notice__title">What Unknown means here</div>
          <p>
            Adericel does not hold sufficient trustworthy evidence to make a statement about{' '}
            {data.counts.UNKNOWN} control{data.counts.UNKNOWN === 1 ? '' : 's'}. That is not the
            same as compliant or non-compliant. Each unknown control below states its reason.
          </p>
        </div>
      ) : null}

      {data.frameworks.length > 0 ? (
        <Section title="Frameworks">
          <div className="grid grid--3">
            {data.frameworks.map((framework) => (
              <div key={framework.id} className="panel stack">
                <div className="row row--between">
                  <h3>{framework.name}</h3>
                  <StateChip state={framework.state} />
                </div>
                <code className="meta">{framework.key}</code>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Controls" note="Worst first">
        <div className="panel panel--flush table__wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Control</th>
                <th>State</th>
                <th>Why</th>
                <th>In this state</th>
                <th>Last assessed</th>
              </tr>
            </thead>
            <tbody>
              {controls.map((control) => (
                <tr key={control.id}>
                  <td>
                    <Link to={`/organisations/${organisationId}/controls/${control.id}`}>
                      {control.title}
                    </Link>
                    <div>
                      <code className="meta">{control.key}</code>
                    </div>
                  </td>
                  <td>
                    <StateChip
                      state={control.state as AssuranceState}
                      reason={
                        control.unknownReason
                          ? (UNKNOWN_REASON_TEXT[control.unknownReason] ?? control.unknownReason)
                          : null
                      }
                    />
                  </td>
                  <td className="meta">
                    {control.unknownReason
                      ? (UNKNOWN_REASON_TEXT[control.unknownReason] ?? control.unknownReason)
                      : '—'}
                  </td>
                  <td className="meta">{since(control.since)}</td>
                  <td className="meta">{since(control.lastAssessedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Operational position">
        <div className="grid grid--4">
          <Metric
            value={data.openFindings.total}
            label="Open findings"
            note={`${data.openFindings.critical} critical, ${data.openFindings.high} high`}
            tone={data.openFindings.critical > 0 ? 'failing' : undefined}
          />
          <Metric
            value={
              data.openFindings.oldestDetectedAt ? since(data.openFindings.oldestDetectedAt) : '—'
            }
            label="Oldest finding"
            note="Measured from first detection"
          />
          <Metric
            value={data.evidence.expired + data.evidence.expiringWithin7Days}
            label="Evidence needing attention"
            note={`${data.evidence.expired} expired, ${data.evidence.expiringWithin7Days} expiring this week`}
            tone={data.evidence.expired > 0 ? 'exception' : undefined}
          />
          <Metric
            value={data.actions.awaitingApproval}
            label="Awaiting approval"
            note={`${data.actions.unverified} unverified`}
          />
        </div>
      </Section>
    </>
  );
}
