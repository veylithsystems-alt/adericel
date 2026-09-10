import type { ReactElement } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Empty, ErrorNotice, Loading, PageHeader, Section } from '../components/Shell.js';
import { Metric } from '../components/State.js';
import { useApi } from '../lib/use-api.js';
import { formatInstant, since } from '../lib/assurance-presentation.js';
import type { EvidenceItem } from '../lib/types.js';

/**
 * Proof: the evidence explorer.
 *
 * Usability is shown beside status, because they are different questions.
 * Evidence can be ACTIVE and still unusable — beyond its freshness limit, or
 * resting on a source that has since been revoked — and it is usability that
 * determines whether a control can be proven.
 */
export function Proof(): ReactElement {
  const { organisationId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const highlighted = searchParams.get('evidence');
  const onlyUsable = searchParams.get('usable') === 'true';

  const evidence = useApi<{ evidence: EvidenceItem[]; hasMore: boolean }>(
    organisationId
      ? `/v1/organisations/${organisationId}/evidence?limit=200${onlyUsable ? '&onlyUsable=true' : ''}`
      : null,
  );

  const integrations = useApi<{
    integrations: {
      id: string;
      connectorKey: string;
      name: string;
      status: string;
      lastSuccessAt: string | null;
      lastError: string | null;
      consecutiveFailures: number;
      health: string;
      fidelity: string;
      observationCount: number;
    }[];
  }>(organisationId ? `/v1/organisations/${organisationId}/integrations` : null);

  const coverage = useApi<{
    domains: {
      domain: string;
      noConnectorExists: boolean;
      capabilities: { key: string; title: string; available: boolean; sources: string[] }[];
    }[];
    requiredPredicates: number;
    satisfiedPredicates: number;
    gaps: { predicate: string; wouldBeSuppliedBy: { connectorKey: string; name: string }[] }[];
    brokenCapabilities: {
      integrationName: string;
      capability: string;
      outcome: string;
      detail: string;
      requiredPermission: string;
      unavailablePredicates: string[];
    }[];
    containsDemonstrationData: boolean;
  }>(organisationId ? `/v1/organisations/${organisationId}/observation-coverage` : null);

  const conflicts = useApi<{
    conflicts: {
      id: string;
      predicate: string;
      subjectExternalId: string | null;
      blocksAssurance: boolean;
      sources: { name: string; value: unknown }[];
      detail: string;
    }[];
  }>(organisationId ? `/v1/organisations/${organisationId}/source-conflicts` : null);

  if (evidence.loading) return <Loading what="evidence" />;
  if (evidence.error) return <ErrorNotice error={evidence.error} />;

  const items = evidence.data?.evidence ?? [];
  const usable = items.filter((item) => item.usable).length;
  const stale = items.filter(
    (item) => item.freshness === 'STALE' || item.freshness === 'EXPIRED',
  ).length;
  const ageing = items.filter((item) => item.freshness === 'AGEING').length;

  return (
    <>
      <PageHeader
        title="Proof"
        lead="Every artefact Adericel holds, where it came from, and whether it can still be relied upon."
      />

      {coverage.data?.containsDemonstrationData ? (
        // Not a subtle badge. Somebody looking at this page is deciding whether
        // to believe a determination, and demonstration data cannot support one.
        <div
          className="notice notice--unknown"
          role="status"
          style={{ marginBottom: 'var(--space-6)' }}
        >
          <div className="notice__title">This organisation contains demonstration data</div>
          At least one source is a demonstration fixture, not a real system. Anything resting on
          it describes an example estate and must not be relied on, shared, or presented as
          assurance.
        </div>
      ) : null}

      <Section title="Evidence position">
        <div className="grid grid--4">
          <Metric
            value={usable}
            label="Usable now"
            note={`of ${items.length} held`}
            tone="proven"
          />
          <Metric
            value={ageing}
            label="Ageing"
            note="Approaching its freshness limit"
            tone={ageing > 0 ? 'exception' : undefined}
          />
          <Metric
            value={stale}
            label="Stale or expired"
            note="No longer supports a positive claim"
            tone={stale > 0 ? 'failing' : undefined}
          />
          <Metric
            value={items.filter((i) => i.status === 'REVOKED').length}
            label="Revoked"
            note="Withdrawn, but retained for history"
          />
        </div>
      </Section>

      {integrations.data && integrations.data.integrations.length > 0 ? (
        <Section title="Sources">
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Connector</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Last successful collection</th>
                  <th className="table__numeric">Observations</th>
                </tr>
              </thead>
              <tbody>
                {integrations.data.integrations.map((integration) => (
                  <tr key={integration.id}>
                    <td>{integration.name}</td>
                    <td>
                      <code className="meta">{integration.connectorKey}</code>
                    </td>
                    <td>
                      {integration.fidelity === 'DEMONSTRATION' ? (
                        // Not a state class: DEMONSTRATION describes the
                        // source, not Adericel's confidence in a fact.
                        <span className="provenance">demonstration</span>
                      ) : (
                        <span className="meta">live</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`state state--${
                          integration.status === 'CONNECTED'
                            ? 'proven'
                            : integration.status === 'FAILED'
                              ? 'failing'
                              : integration.status === 'DEGRADED'
                                ? 'exception'
                                : 'muted'
                        }`}
                      >
                        <span className="state__dot" aria-hidden="true" />
                        {integration.status.toLowerCase()}
                      </span>
                      {integration.health !== 'HEALTHY' && integration.health !== 'NEVER_RUN' ? (
                        <div className="meta">{integration.health.replace(/_/g, ' ').toLowerCase()}</div>
                      ) : null}
                      {integration.health === 'NEVER_RUN' ? (
                        <div className="meta">never run</div>
                      ) : null}
                      {integration.lastError ? (
                        <div className="meta" style={{ color: 'var(--state-failing)' }}>
                          {integration.lastError}
                        </div>
                      ) : null}
                    </td>
                    <td className="meta">{since(integration.lastSuccessAt)}</td>
                    <td className="table__numeric">{integration.observationCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {conflicts.data && conflicts.data.conflicts.length > 0 ? (
        <Section title="Sources that disagree">
          <div className="notice notice--unknown" style={{ marginBottom: 'var(--space-4)' }}>
            <div className="notice__title">
              {conflicts.data.conflicts.length} fact
              {conflicts.data.conflicts.length === 1 ? '' : 's'} Adericel will not assert
            </div>
            Two systems contradict each other and nothing tells Adericel which to believe. It
            will not choose, so every control resting on these reads UNKNOWN until the
            disagreement is settled.
          </div>
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Fact</th>
                  <th>Subject</th>
                  <th>What each source says</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.data.conflicts.map((conflict) => (
                  <tr key={conflict.id}>
                    <td>
                      <code className="meta">{conflict.predicate}</code>
                    </td>
                    <td className="meta">{conflict.subjectExternalId ?? 'the organisation'}</td>
                    <td>
                      {conflict.sources.map((source) => (
                        <div key={source.name} className="meta">
                          {source.name}: <strong>{JSON.stringify(source.value)}</strong>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {coverage.data ? (
        <Section title="What Adericel can see">
          <div className="grid grid--4" style={{ marginBottom: 'var(--space-4)' }}>
            <Metric
              value={coverage.data.satisfiedPredicates}
              label="Facts a source supplies"
              note={`of ${coverage.data.requiredPredicates} your frameworks need`}
            />
            <Metric
              value={coverage.data.gaps.filter((g) => g.wouldBeSuppliedBy.length > 0).length}
              label="Gaps a connector would close"
              note="Connect the named source"
              tone="exception"
            />
            <Metric
              value={coverage.data.gaps.filter((g) => g.wouldBeSuppliedBy.length === 0).length}
              label="Gaps needing a person"
              note="No connector supplies these yet"
            />
            <Metric
              value={coverage.data.brokenCapabilities.length}
              label="Capabilities failing"
              note="Something connected cannot see"
              tone={coverage.data.brokenCapabilities.length > 0 ? 'failing' : undefined}
            />
          </div>

          {coverage.data.brokenCapabilities.length > 0 ? (
            <div className="notice notice--failing" style={{ marginBottom: 'var(--space-4)' }}>
              <div className="notice__title">A connected source cannot see something</div>
              {coverage.data.brokenCapabilities.map((broken) => (
                <div key={`${broken.integrationName}:${broken.capability}`} className="meta">
                  {broken.integrationName}: {broken.detail}
                  {broken.unavailablePredicates.length > 0
                    ? ` (${broken.unavailablePredicates.length} fact${
                        broken.unavailablePredicates.length === 1 ? '' : 's'
                      } unavailable)`
                    : ''}
                </div>
              ))}
            </div>
          ) : null}

          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Coverage</th>
                  <th>Sources</th>
                </tr>
              </thead>
              <tbody>
                {coverage.data.domains.map((domain) => (
                  <tr key={domain.domain}>
                    <td>{domain.domain.toLowerCase()}</td>
                    <td className="meta">
                      {domain.noConnectorExists
                        ? 'Adericel has no connector for this yet'
                        : `${domain.capabilities.filter((c) => c.available).length} of ${
                            domain.capabilities.length
                          } connected`}
                    </td>
                    <td className="meta">
                      {[
                        ...new Set(domain.capabilities.flatMap((c) => c.sources)),
                      ].join(', ') || '\u2014'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      <Section
        title="Evidence"
        actions={
          <label className="meta row" style={{ gap: 'var(--space-2)' }}>
            <input
              type="checkbox"
              checked={onlyUsable}
              onChange={(event) => {
                const next = new URLSearchParams(searchParams);
                if (event.target.checked) next.set('usable', 'true');
                else next.delete('usable');
                setSearchParams(next);
              }}
            />
            Only evidence that can currently be relied upon
          </label>
        }
      >
        {items.length === 0 ? (
          <Empty>No evidence has been collected for this organisation yet.</Empty>
        ) : (
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Artefact</th>
                  <th>Source</th>
                  <th>Integrity</th>
                  <th>Usable</th>
                  <th>Observed</th>
                  <th>Valid until</th>
                  <th>Content hash</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    style={
                      item.id === highlighted
                        ? { outline: '2px solid var(--ink)', outlineOffset: '-2px' }
                        : undefined
                    }
                  >
                    <td>
                      <div>{item.title}</div>
                      <div className="meta">
                        {item.collectionMethod.replace(/_/g, ' ').toLowerCase()} by{' '}
                        {item.collectedByActor}
                      </div>
                    </td>
                    <td className="meta">
                      {item.sourceSystem}
                      <div>{item.sourceType.replace(/_/g, ' ').toLowerCase()}</div>
                    </td>
                    <td className="meta">
                      {/*
                        Integrity describes the artefact, not the organisation.
                        Hash-verified means we can prove it has not changed since
                        we stored it — not that its contents are true.
                      */}
                      {item.integrityLevel.replace(/_/g, ' ').toLowerCase()}
                    </td>
                    <td>
                      {item.usable ? (
                        <span className="state state--proven">
                          <span className="state__dot" aria-hidden="true" />
                          {item.freshness === 'AGEING' ? 'ageing' : 'usable'}
                        </span>
                      ) : (
                        <span
                          className="state state--failing"
                          title={item.usabilityReason ?? undefined}
                        >
                          <span className="state__dot" aria-hidden="true" />
                          {item.freshness.toLowerCase()}
                        </span>
                      )}
                      {item.usabilityReason ? (
                        <div className="meta">{item.usabilityReason}</div>
                      ) : null}
                    </td>
                    <td className="meta">{since(item.observedAt ?? item.collectedAt)}</td>
                    <td className="meta">
                      {item.validUntil ? formatInstant(item.validUntil) : 'no expiry'}
                    </td>
                    <td>
                      <span className="hash">
                        {item.contentHash.replace('sha256:', '').slice(0, 16)}…
                      </span>
                      {item.hasStoredArtefact ? (
                        <div>
                          <a
                            className="meta"
                            href={`/api/v1/organisations/${organisationId}/evidence/${item.id}/content`}
                          >
                            download
                          </a>
                        </div>
                      ) : null}
                    </td>
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
