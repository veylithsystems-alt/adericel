import { useState, type ReactElement } from 'react';
import { useParams } from 'react-router-dom';
import { Empty, ErrorNotice, Loading, PageHeader, Section } from '../components/Shell.js';
import { useApi } from '../lib/use-api.js';
import { since } from '../lib/assurance-presentation.js';
import type { GraphNodeSummary } from '../lib/types.js';

/**
 * Ask: explore the assurance graph.
 *
 * The graph is the canonical model, so it is browsable rather than hidden
 * behind dashboards. Selecting an asset shows what Adericel knows about it,
 * what it is connected to, and what it currently claims.
 */
export function Ask(): ReactElement {
  const { organisationId } = useParams();
  const [kind, setKind] = useState<string>('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const summary = useApi<{ countsByKind: Record<string, number> }>(
    organisationId ? `/v1/organisations/${organisationId}/nodes/summary` : null,
  );

  const nodes = useApi<{ nodes: GraphNodeSummary[] }>(
    organisationId
      ? `/v1/organisations/${organisationId}/nodes?limit=100${kind ? `&kind=${kind}` : ''}${
          search ? `&search=${encodeURIComponent(search)}` : ''
        }`
      : null,
    [kind, search],
  );

  const detail = useApi<{
    node: GraphNodeSummary;
    edges: {
      outgoing: { id: string; kind: string; toNodeId: string }[];
      incoming: { id: string; kind: string; fromNodeId: string }[];
    };
    claims: { id: string; predicate: string; value: unknown; origin: string; status: string; assertedAt: string }[];
    evidenceCount: number;
    openFindings: { id: string; title: string; severity: string }[];
  }>(selected && organisationId ? `/v1/organisations/${organisationId}/nodes/${selected}` : null);

  return (
    <>
      <PageHeader
        title="Ask"
        lead="The organisational assurance graph: what exists, what it is connected to, and what Adericel currently claims about it."
      />

      <Section title="What Adericel knows exists">
        {summary.loading ? (
          <Loading what="the graph" />
        ) : (
          <div className="row">
            <button
              type="button"
              className={`button button--small ${kind === '' ? '' : 'button--secondary'}`}
              onClick={() => setKind('')}
            >
              All
            </button>
            {Object.entries(summary.data?.countsByKind ?? {})
              .sort((a, b) => b[1] - a[1])
              .map(([nodeKind, count]) => (
                <button
                  key={nodeKind}
                  type="button"
                  className={`button button--small ${kind === nodeKind ? '' : 'button--secondary'}`}
                  onClick={() => setKind(nodeKind)}
                >
                  {nodeKind} <span className="data">{count}</span>
                </button>
              ))}
          </div>
        )}
      </Section>

      <Section title="Assets">
        <div className="field" style={{ maxWidth: '24rem', marginBottom: 'var(--space-4)' }}>
          <label className="field__label" htmlFor="node-search">
            Search by name
          </label>
          <input
            id="node-search"
            className="input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="A person, a device, a supplier…"
          />
        </div>

        {nodes.loading ? (
          <Loading what="assets" />
        ) : nodes.error ? (
          <ErrorNotice error={nodes.error} />
        ) : (nodes.data?.nodes.length ?? 0) === 0 ? (
          <Empty>Nothing matches.</Empty>
        ) : (
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Source identifier</th>
                  <th>Last observed</th>
                </tr>
              </thead>
              <tbody>
                {nodes.data?.nodes.map((node) => (
                  <tr
                    key={node.id}
                    onClick={() => setSelected(node.id)}
                    style={{
                      cursor: 'pointer',
                      ...(node.id === selected
                        ? { outline: '2px solid var(--ink)', outlineOffset: '-2px' }
                        : {}),
                    }}
                  >
                    <td>{node.label}</td>
                    <td className="meta">{node.kind}</td>
                    <td>
                      <code className="meta">{node.externalId ?? '—'}</code>
                    </td>
                    <td className="meta">{since(node.lastObservedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {selected && detail.data ? (
        <Section title={detail.data.node.label} note={detail.data.node.kind}>
          <div className="grid grid--2">
            <div className="panel stack">
              <h3>What Adericel claims</h3>
              {detail.data.claims.length === 0 ? (
                <p className="meta">No claims are recorded about this asset.</p>
              ) : (
                <table className="table">
                  <tbody>
                    {detail.data.claims.map((claim) => (
                      <tr key={claim.id}>
                        <td>
                          <code className="data">{claim.predicate}</code>
                        </td>
                        <td>
                          <code className="data">{JSON.stringify(claim.value)}</code>
                        </td>
                        <td className="meta">{since(claim.assertedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="panel stack">
              <h3>Connections</h3>
              <p className="meta">
                {detail.data.edges.outgoing.length} outgoing, {detail.data.edges.incoming.length} incoming
                · {detail.data.evidenceCount} piece
                {detail.data.evidenceCount === 1 ? '' : 's'} of evidence
              </p>
              {detail.data.openFindings.length > 0 ? (
                <div className="notice notice--failing">
                  <div className="notice__title">
                    {detail.data.openFindings.length} open finding
                    {detail.data.openFindings.length === 1 ? '' : 's'}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
                    {detail.data.openFindings.map((finding) => (
                      <li key={finding.id}>{finding.title}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="stack">
                {[...detail.data.edges.outgoing, ...detail.data.edges.incoming]
                  .slice(0, 12)
                  .map((edge) => (
                    <code key={edge.id} className="data">
                      {edge.kind}
                    </code>
                  ))}
              </div>
            </div>
          </div>
        </Section>
      ) : null}
    </>
  );
}
