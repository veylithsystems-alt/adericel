import { useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { SeverityChip, StateChip } from '../components/State.js';
import { Empty, ErrorNotice, Loading, PageHeader, Section } from '../components/Shell.js';
import { useApi, useMutation } from '../lib/use-api.js';
import { UNKNOWN_REASON_TEXT, formatInstant, since } from '../lib/assurance-presentation.js';
import type { ControlExplanation as Explanation } from '../lib/types.js';

/**
 * Why a control is in its current state.
 *
 * This page is the product's core claim made visible: state, the rule that
 * produced it, the exact conditions that were evaluated, every claim consulted,
 * every piece of evidence behind those claims, and the ruleset version and
 * input digest needed to reproduce the determination.
 *
 * A user should be able to get from a red mark to the named person or device
 * causing it, and to the evidence that proves it, without leaving this screen.
 */
export function ControlExplanation(): ReactElement {
  const { organisationId, controlId } = useParams();
  const path =
    organisationId && controlId
      ? `/v1/organisations/${organisationId}/controls/${controlId}/explanation`
      : null;
  const explanation = useApi<Explanation>(path);
  const [replayResult, setReplayResult] = useState<string | null>(null);

  const replay = useMutation<string, { reproduced: boolean; explanation: string }>((assessmentId) => ({
    path: `/v1/organisations/${organisationId}/assessments/${assessmentId}/replay`,
    options: { method: 'POST' },
  }));

  const reassess = useMutation<void, unknown>(() => ({
    path: `/v1/organisations/${organisationId}/assessments`,
    options: {
      method: 'POST',
      body: { subjectKind: 'CONTROL', subjectId: controlId, trigger: 'MANUAL' },
    },
  }));

  if (explanation.loading) return <Loading what="the explanation" />;
  if (explanation.error) return <ErrorNotice error={explanation.error} />;
  if (!explanation.data) return <Empty>No explanation available.</Empty>;

  const data = explanation.data;

  return (
    <>
      <PageHeader
        title={data.control.title}
        lead={data.control.description ?? undefined}
        actions={
          <>
            <Link className="button button--secondary" to={`/organisations/${organisationId}`}>
              Back to assurance
            </Link>
            <button
              type="button"
              className="button"
              disabled={reassess.running}
              onClick={() => void reassess.run().then(() => explanation.reload())}
            >
              {reassess.running ? 'Assessing…' : 'Assess now'}
            </button>
          </>
        }
      />

      <Section title="Determination">
        <div className="panel stack">
          <div className="row">
            <StateChip
              state={data.state}
              reason={
                data.unknownReason
                  ? (UNKNOWN_REASON_TEXT[data.unknownReason] ?? data.unknownReason)
                  : null
              }
            />
            {data.rule ? <SeverityChip severity={data.rule.severity} /> : null}
            <code className="meta">{data.control.key}</code>
          </div>

          <p>{data.rationale}</p>

          {data.state === 'UNKNOWN' ? (
            <div className="notice notice--unknown">
              <div className="notice__title">This is not a pass and not a failure</div>
              <p>
                Adericel does not hold sufficient trustworthy evidence to determine this control.{' '}
                {data.unknownReason
                  ? `${UNKNOWN_REASON_TEXT[data.unknownReason] ?? data.unknownReason}.`
                  : ''}{' '}
                Until that changes, no positive claim can be made about it.
              </p>
            </div>
          ) : null}

          {data.state === 'NOT_SATISFIED' && data.rule ? (
            <div className="notice notice--failing">
              <div className="notice__title">Required change</div>
              <p>{data.rule.requiredWhenFailing}</p>
            </div>
          ) : null}
        </div>
      </Section>

      <Section title="How this was decided" note="Every condition the rule evaluated">
        <div className="panel">
          <ul className="reasoning">
            {data.reasoning.map((step, index) => (
              <li key={`${step.step}-${index}`} className="reasoning__step">
                <span className={`reasoning__outcome reasoning__outcome--${step.outcome}`}>
                  {step.outcome}
                </span>
                <span>
                  <code>{step.step}</code>
                  <div className="meta">{step.detail}</div>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {data.assessment ? (
        <Section
          title="Provenance"
          note="Everything needed to reproduce this determination"
          actions={
            <button
              type="button"
              className="button button--small button--secondary"
              disabled={replay.running}
              onClick={() => {
                void replay.run(data.assessment!.id).then((result) => {
                  if (result) setReplayResult(result.explanation);
                });
              }}
            >
              {replay.running ? 'Replaying…' : 'Replay this assessment'}
            </button>
          }
        >
          <div className="panel stack">
            <div className="grid grid--2">
              <div className="stack">
                <div>
                  <span className="metric__label">Ruleset</span>
                  <div className="data">
                    {data.assessment.provenance.rulesetKey}@{data.assessment.provenance.rulesetVersion}
                  </div>
                </div>
                <div>
                  <span className="metric__label">Rule</span>
                  <div className="data">{data.assessment.provenance.ruleKey}</div>
                </div>
                <div>
                  <span className="metric__label">Engine</span>
                  <div className="data">{data.assessment.provenance.engineVersion}</div>
                </div>
              </div>
              <div className="stack">
                <div>
                  <span className="metric__label">Ruleset hash</span>
                  <div className="hash">{data.assessment.provenance.rulesetHash}</div>
                </div>
                <div>
                  <span className="metric__label">Input digest</span>
                  <div className="hash">{data.assessment.provenance.inputDigest}</div>
                </div>
                <div>
                  <span className="metric__label">Assessed</span>
                  <div className="data">{formatInstant(data.assessment.assessedAt)}</div>
                </div>
              </div>
            </div>

            {replayResult ? (
              <div
                className={`notice ${replay.result?.reproduced ? 'notice--proven' : 'notice--exception'}`}
              >
                <div className="notice__title">
                  {replay.result?.reproduced ? 'Reproduced exactly' : 'Could not be reproduced'}
                </div>
                <p>{replayResult}</p>
              </div>
            ) : null}
            {replay.error ? <ErrorNotice error={replay.error} /> : null}
          </div>
        </Section>
      ) : null}

      {data.openFindings.length > 0 ? (
        <Section title="Open findings">
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Finding</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>Open for</th>
                </tr>
              </thead>
              <tbody>
                {data.openFindings.map((finding) => (
                  <tr key={finding.id}>
                    <td>{finding.title}</td>
                    <td>
                      <SeverityChip severity={finding.severity} />
                    </td>
                    <td className="meta">{finding.status}</td>
                    <td className="meta">{since(finding.firstDetectedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      <Section title="Claims consulted" note="The structured facts the rule read">
        {data.claims.length === 0 ? (
          <Empty>No claims were available to this rule.</Empty>
        ) : (
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Predicate</th>
                  <th>Subject</th>
                  <th>Value</th>
                  <th>Origin</th>
                  <th>Status</th>
                  <th>Asserted</th>
                </tr>
              </thead>
              <tbody>
                {data.claims.map((claim) => (
                  <tr key={claim.id}>
                    <td>
                      <code className="data">{claim.predicate}</code>
                    </td>
                    <td>{claim.subject ?? <span className="meta">organisation-wide</span>}</td>
                    <td>
                      <code className="data">{JSON.stringify(claim.value)}</code>
                    </td>
                    <td className="meta">
                      {claim.origin === 'AI_SUGGESTED' ? (
                        <span className="state state--exception">
                          <span className="state__dot" aria-hidden="true" />
                          AI-suggested
                        </span>
                      ) : (
                        claim.origin.replace(/_/g, ' ').toLowerCase()
                      )}
                    </td>
                    <td className="meta">{claim.status.toLowerCase()}</td>
                    <td className="meta">{since(claim.assertedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Evidence" note="What the claims rest on">
        {data.evidence.length === 0 ? (
          <Empty>No evidence supports this determination.</Empty>
        ) : (
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Evidence</th>
                  <th>Source</th>
                  <th>Integrity</th>
                  <th>Observed</th>
                  <th>Valid until</th>
                  <th>Content hash</th>
                </tr>
              </thead>
              <tbody>
                {data.evidence.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link to={`/organisations/${organisationId}/proof?evidence=${item.id}`}>
                        {item.title}
                      </Link>
                      <div className="meta">{item.status.toLowerCase()}</div>
                    </td>
                    <td className="meta">
                      {item.sourceSystem}
                      <div>{item.sourceType.replace(/_/g, ' ').toLowerCase()}</div>
                    </td>
                    <td className="meta">{item.integrityLevel.replace(/_/g, ' ').toLowerCase()}</td>
                    <td className="meta">{since(item.observedAt ?? item.collectedAt)}</td>
                    <td className="meta">
                      {item.validUntil ? formatInstant(item.validUntil) : 'no expiry'}
                    </td>
                    <td>
                      <span className="hash">{item.contentHash.slice(0, 23)}…</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {data.requirements.length > 0 ? (
        <Section title="Requirements this control contributes to">
          <div className="panel stack">
            {data.requirements.map((requirement) => (
              <div key={requirement.id} className="row">
                <code className="data">{requirement.key}</code>
                <span>{requirement.title}</span>
                <span className="spacer" />
                <span className="meta">{requirement.framework}</span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {data.activeExceptions.length > 0 ? (
        <Section title="Active exceptions">
          <div className="panel stack">
            {data.activeExceptions.map((exception) => (
              <div key={exception.id} className="notice notice--exception">
                <div className="notice__title">Expires {formatInstant(exception.expiresAt)}</div>
                <p>{exception.justification}</p>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </>
  );
}
