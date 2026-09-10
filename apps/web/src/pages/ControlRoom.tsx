import type { ReactElement } from 'react';
import { Empty, ErrorNotice, Loading, PageHeader, Section } from '../components/Shell.js';
import { Metric } from '../components/State.js';
import { useApi } from '../lib/use-api.js';
import { since, until } from '../lib/assurance-presentation.js';
import type { Me } from '../lib/types.js';

/**
 * The internal control room.
 *
 * One page answering the question a person governing an autonomous company
 * needs answered without opening five systems: what is it doing, why, what has
 * failed, and what needs me.
 *
 * The exception queue comes first, before any metric. Metrics are for
 * understanding the company over weeks; the queue is what somebody has to deal
 * with today, and putting the dashboard above it would invite reading the
 * numbers instead of doing the work.
 */

interface ExceptionRow {
  id: string;
  processKey: string;
  category: string;
  severity: string;
  title: string;
  attempted: string;
  failureReason: string;
  recommendedAction: string;
  requiredAuthority: string;
  status: string;
  dueAt: string;
  occurrences: number;
}

interface AutonomyBody {
  metrics: {
    windowHours: number;
    operations: number;
    autonomous: number;
    automationRatio: number | null;
    humanInterventions: number;
    exceptionsRaised: number;
    exceptionsOpen: number;
    exceptionsOverdue: number;
    unknownOutcomes: number;
    refusals: Record<string, number>;
  };
  processes: {
    processKey: string;
    domain: string;
    title: string;
    currentMaturity: number;
    targetMaturity: number;
    humanBoundary: string;
    automationCandidate: boolean;
    operations: number;
    autonomous: number;
    exceptions: number;
    observedMaturity: number | null;
  }[];
  overstatedProcesses: { processKey: string; recorded: number; observed: number }[];
  policy: { key: string; hash: string; rules: number };
}

/** A proportion, or an honest dash when there is nothing to divide by. */
function ratio(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

export function ControlRoom({ me }: { me: Me }): ReactElement {
  const isPlatform = me.permissions.includes('platform:read');

  const exceptions = useApi<{ exceptions: ExceptionRow[]; overdueCount: number }>(
    isPlatform ? '/v1/veylith/exceptions' : null,
  );
  const autonomy = useApi<AutonomyBody>(isPlatform ? '/v1/veylith/autonomy' : null);
  const decisions = useApi<{
    decisions: {
      id: string;
      processKey: string;
      operation: string;
      outcome: string;
      reason: string;
      decidedAt: string;
    }[];
  }>(isPlatform ? '/v1/veylith/decisions?refusalsOnly=true&limit=25' : null);

  if (!isPlatform) {
    return (
      <>
        <PageHeader title="Control room" lead="Veylith's own operations." />
        <div className="notice notice--failing" role="alert">
          <div className="notice__title">Not available to this account</div>
          The control room shows Veylith's internal operations. It is not customer data and is
          not reachable from a customer account.
        </div>
      </>
    );
  }

  if (exceptions.loading || autonomy.loading) return <Loading what="company operations" />;
  if (exceptions.error) return <ErrorNotice error={exceptions.error} />;
  if (autonomy.error) return <ErrorNotice error={autonomy.error} />;

  const metrics = autonomy.data?.metrics;
  const queue = exceptions.data?.exceptions ?? [];
  const overdue = exceptions.data?.overdueCount ?? 0;

  return (
    <>
      <PageHeader
        title="Control room"
        lead="What the company is doing, what it refused to do, and what needs a person."
      />

      {/* The queue first. Metrics are for understanding the company over weeks;
          this is what somebody has to deal with today. */}
      <Section title="Needs a person">
        {queue.length === 0 ? (
          <Empty>
            Nothing is waiting. No automation has stopped needing a decision — which is the
            intended steady state rather than an absence of activity, and the backlog below shows
            what actually ran.
          </Empty>
        ) : (
          <>
            {overdue > 0 ? (
              <div
                className="notice notice--failing"
                role="alert"
                style={{ marginBottom: 'var(--space-4)' }}
              >
                <div className="notice__title">
                  {overdue} exception{overdue === 1 ? ' is' : 's are'} past the time they should
                  have been looked at
                </div>
                An exception nobody opens is indistinguishable from one nobody raised.
              </div>
            ) : null}
            <div className="panel panel--flush table__wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>What stopped</th>
                    <th>Why</th>
                    <th>Who is needed</th>
                    <th>Due</th>
                    <th className="table__numeric">Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((exception) => (
                    <tr key={exception.id}>
                      <td>
                        <div>{exception.title}</div>
                        <code className="meta">{exception.processKey}</code>
                      </td>
                      <td>
                        <div className="meta">{exception.failureReason}</div>
                        {exception.recommendedAction ? (
                          <div className="meta">→ {exception.recommendedAction}</div>
                        ) : null}
                      </td>
                      <td className="meta">{exception.requiredAuthority || '—'}</td>
                      <td className="meta">{until(exception.dueAt)}</td>
                      <td className="table__numeric">{exception.occurrences}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      {metrics ? (
        <Section title="How autonomous the company actually is">
          <div className="grid grid--4">
            <Metric
              value={ratio(metrics.automationRatio)}
              label="Ran without a person"
              note={
                metrics.operations === 0
                  ? 'Nothing was attempted in this window'
                  : `${metrics.autonomous} of ${metrics.operations} operations`
              }
            />
            <Metric
              value={metrics.exceptionsOpen}
              label="Open exceptions"
              note={`${metrics.exceptionsRaised} raised in this window`}
              tone={metrics.exceptionsOpen > 0 ? 'exception' : undefined}
            />
            <Metric
              value={metrics.humanInterventions}
              label="Human interventions"
              note="Decisions a person made or confirmed"
            />
            <Metric
              value={metrics.unknownOutcomes}
              label="Unestablished outcomes"
              note="Dispatched; whether it took effect is unknown"
              tone={metrics.unknownOutcomes > 0 ? 'failing' : undefined}
            />
          </div>

          <div className="notice notice--unknown" style={{ marginTop: 'var(--space-4)' }}>
            <div className="notice__title">What the company declined to do</div>
            Refused outright {metrics.refusals.DENY ?? 0} ·{' '}
            needed approval {metrics.refusals.REQUIRE_APPROVAL ?? 0} ·{' '}
            escalated {metrics.refusals.ESCALATE ?? 0} ·{' '}
            could not tell {metrics.refusals.UNKNOWN ?? 0}
            <div className="meta" style={{ marginTop: 'var(--space-2)' }}>
              A rising “could not tell” means operations are reaching the policy that nobody wrote
              a rule for. That is the number to watch, not the refusals.
            </div>
          </div>
        </Section>
      ) : null}

      {autonomy.data && autonomy.data.overstatedProcesses.length > 0 ? (
        <Section title="Processes claiming more autonomy than they have">
          <div className="notice notice--failing" style={{ marginBottom: 'var(--space-4)' }}>
            <div className="notice__title">The plan and the evidence disagree</div>
            These processes are recorded at a maturity their own execution history does not
            support. The recorded figure is the plan; the observed one is what the ledger says.
          </div>
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Process</th>
                  <th className="table__numeric">Recorded</th>
                  <th className="table__numeric">Observed</th>
                </tr>
              </thead>
              <tbody>
                {autonomy.data.overstatedProcesses.map((row) => (
                  <tr key={row.processKey}>
                    <td>
                      <code className="meta">{row.processKey}</code>
                    </td>
                    <td className="table__numeric">L{row.recorded}</td>
                    <td className="table__numeric">L{row.observed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {autonomy.data ? (
        <Section title="The autonomy backlog">
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Process</th>
                  <th>Now → target</th>
                  <th>What a person always decides</th>
                  <th className="table__numeric">Ran</th>
                </tr>
              </thead>
              <tbody>
                {autonomy.data.processes.map((process) => (
                  <tr key={process.processKey}>
                    <td>
                      <div>{process.title}</div>
                      <code className="meta">{process.processKey}</code>
                    </td>
                    <td className="meta">
                      {process.automationCandidate ? (
                        `L${process.currentMaturity} → L${process.targetMaturity}`
                      ) : (
                        <span className="provenance">never automated</span>
                      )}
                    </td>
                    <td className="meta">{process.humanBoundary || '—'}</td>
                    <td className="table__numeric">{process.operations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {decisions.data && decisions.data.decisions.length > 0 ? (
        <Section title="Recent refusals">
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Outcome</th>
                  <th>Reason</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {decisions.data.decisions.map((decision) => (
                  <tr key={decision.id}>
                    <td>
                      <code className="meta">{decision.operation}</code>
                    </td>
                    <td className="meta">{decision.outcome.replace(/_/g, ' ').toLowerCase()}</td>
                    <td className="meta">{decision.reason}</td>
                    <td className="meta">{since(decision.decidedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {autonomy.data ? (
        <p className="meta">
          Decided under policy <code>{autonomy.data.policy.key}</code> ({autonomy.data.policy.rules}{' '}
          rules), <code>{autonomy.data.policy.hash.slice(0, 23)}…</code>
        </p>
      ) : null}
    </>
  );
}
