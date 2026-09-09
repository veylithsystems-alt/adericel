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
      observationCount: number;
    }[];
  }>(organisationId ? `/v1/organisations/${organisationId}/integrations` : null);

  if (evidence.loading) return <Loading what="evidence" />;
  if (evidence.error) return <ErrorNotice error={evidence.error} />;

  const items = evidence.data?.evidence ?? [];
  const usable = items.filter((item) => item.usable).length;
  const stale = items.filter((item) => item.freshness === 'STALE' || item.freshness === 'EXPIRED').length;
  const ageing = items.filter((item) => item.freshness === 'AGEING').length;

  return (
    <>
      <PageHeader
        title="Proof"
        lead="Every artefact Adericel holds, where it came from, and whether it can still be relied upon."
      />

      <Section title="Evidence position">
        <div className="grid grid--4">
          <Metric value={usable} label="Usable now" note={`of ${items.length} held`} tone="proven" />
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
                        {item.collectionMethod.replace(/_/g, ' ').toLowerCase()} by {item.collectedByActor}
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
                        <span className="state state--failing" title={item.usabilityReason ?? undefined}>
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
                      <span className="hash">{item.contentHash.replace('sha256:', '').slice(0, 16)}…</span>
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
