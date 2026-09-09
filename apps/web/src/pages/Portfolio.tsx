import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { CountBar, Metric, StateChip } from '../components/State.js';
import { Empty, ErrorNotice, Loading, PageHeader, Section } from '../components/Shell.js';
import { useApi } from '../lib/use-api.js';
import { since } from '../lib/assurance-presentation.js';
import type { Me, Portfolio as PortfolioData } from '../lib/types.js';

/**
 * MSP portfolio.
 *
 * Ordered so the customer needing attention first appears first. Unknown counts
 * sit beside failing counts rather than being folded into them, because an MSP
 * that cannot see a customer has a different problem from one whose customer is
 * visibly failing — and only one of those is the customer's fault.
 */
export function Portfolio({ me }: { me: Me }): ReactElement {
  const mspId = me.msps[0]?.id ?? null;
  const portfolio = useApi<PortfolioData>(mspId ? `/v1/msps/${mspId}/portfolio` : null);
  const recurring = useApi<{
    controls: {
      controlKey: string;
      title: string;
      affectedOrganisations: number;
      totalOrganisations: number;
      failing: number;
      unknown: number;
      systemicRemediation: { actionType: string; rationale: string } | null;
    }[];
  }>(mspId ? `/v1/msps/${mspId}/portfolio/recurring-failures?limit=6` : null);

  if (!mspId) {
    return (
      <>
        <PageHeader title="Organisations" />
        <div className="grid grid--2">
          {me.organisations.map((org) => (
            <Link key={org.id} to={`/organisations/${org.id}`} className="panel" style={{ textDecoration: 'none' }}>
              <h2>{org.name}</h2>
              <p className="meta">{org.slug}</p>
            </Link>
          ))}
        </div>
      </>
    );
  }

  if (portfolio.loading) return <Loading what="the portfolio" />;
  if (portfolio.error) return <ErrorNotice error={portfolio.error} />;
  if (!portfolio.data) return <Empty>No portfolio data.</Empty>;

  const { totals, organisations } = portfolio.data;

  return (
    <>
      <PageHeader
        title={me.msps[0]?.name ?? 'Portfolio'}
        lead={`${organisations.length} organisation${organisations.length === 1 ? '' : 's'} under management. Ordered by what needs attention first.`}
      />

      <Section title="Across the portfolio">
        <div className="grid grid--4">
          <Metric
            value={totals.criticalFindings}
            label="Critical findings"
            tone={totals.criticalFindings > 0 ? 'failing' : undefined}
            note={`${totals.openFindings} open in total`}
          />
          <Metric
            value={totals.failingControls}
            label="Failing controls"
            tone={totals.failingControls > 0 ? 'failing' : undefined}
          />
          <Metric
            value={totals.unknownControls}
            label="Unknown controls"
            tone={totals.unknownControls > 0 ? 'unknown' : undefined}
            note="Adericel cannot speak to these"
          />
          <Metric
            value={totals.awaitingApproval}
            label="Awaiting approval"
            note={`${totals.unverifiedActions} unverified action${totals.unverifiedActions === 1 ? '' : 's'}`}
          />
        </div>

        {totals.failedIntegrations > 0 || totals.staleEvidence > 0 ? (
          <div className="notice notice--unknown" style={{ marginTop: 'var(--space-4)' }}>
            <div className="notice__title">These are Adericel's problems, not the customers'</div>
            <p>
              {totals.failedIntegrations > 0
                ? `${totals.failedIntegrations} integration${totals.failedIntegrations === 1 ? ' is' : 's are'} failing to collect. `
                : ''}
              {totals.staleEvidence > 0
                ? `${totals.staleEvidence} evidence record${totals.staleEvidence === 1 ? ' has' : 's have'} passed their freshness limit. `
                : ''}
              Controls depending on them will report Unknown until collection is restored.
            </p>
          </div>
        ) : null}
      </Section>

      <Section title="Customers" note="Worst first">
        <div className="panel panel--flush table__wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Organisation</th>
                <th>State</th>
                <th style={{ width: '14rem' }}>Controls</th>
                <th className="table__numeric">Failing</th>
                <th className="table__numeric">Unknown</th>
                <th className="table__numeric">Critical</th>
                <th className="table__numeric">Approvals</th>
                <th>Last assessed</th>
              </tr>
            </thead>
            <tbody>
              {organisations.map((org) => (
                <tr key={org.organisationId}>
                  <td>
                    <Link to={`/organisations/${org.organisationId}`}>{org.name}</Link>
                    {org.failedIntegrations > 0 ? (
                      <div className="meta" style={{ color: 'var(--state-failing)' }}>
                        {org.failedIntegrations} integration
                        {org.failedIntegrations === 1 ? '' : 's'} not collecting
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <StateChip state={org.state} />
                  </td>
                  <td>
                    <CountBar counts={org.counts} />
                    <div className="meta" style={{ marginTop: 'var(--space-1)' }}>
                      {/*
                        Coverage is stated as a count with its denominator, not
                        as a score. See docs/product/brand.
                      */}
                      {org.counts.SATISFIED + org.counts.EXCEPTED} proven of{' '}
                      {org.counts.SATISFIED +
                        org.counts.EXCEPTED +
                        org.counts.NOT_SATISFIED +
                        org.counts.PARTIALLY_SATISFIED +
                        org.counts.UNKNOWN}{' '}
                      in scope
                    </div>
                  </td>
                  <td className="table__numeric">{org.counts.NOT_SATISFIED || '—'}</td>
                  <td className="table__numeric">{org.counts.UNKNOWN || '—'}</td>
                  <td className="table__numeric" style={org.criticalFindings > 0 ? { color: 'var(--state-failing)' } : undefined}>
                    {org.criticalFindings || '—'}
                  </td>
                  <td className="table__numeric">{org.awaitingApproval || '—'}</td>
                  <td className="meta">{since(org.lastAssessedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {recurring.data && recurring.data.controls.length > 0 ? (
        <Section
          title="Failing across several customers"
          note="One fix, many customers"
        >
          <div className="panel panel--flush table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Control</th>
                  <th className="table__numeric">Customers affected</th>
                  <th className="table__numeric">Failing</th>
                  <th className="table__numeric">Unknown</th>
                  <th>Systemic remediation</th>
                </tr>
              </thead>
              <tbody>
                {recurring.data.controls.map((control) => (
                  <tr key={control.controlKey}>
                    <td>
                      <div>{control.title}</div>
                      <code className="meta">{control.controlKey}</code>
                    </td>
                    <td className="table__numeric">
                      {control.affectedOrganisations} of {control.totalOrganisations}
                    </td>
                    <td className="table__numeric">{control.failing || '—'}</td>
                    <td className="table__numeric">{control.unknown || '—'}</td>
                    <td>
                      {control.systemicRemediation ? (
                        <>
                          <code className="meta">{control.systemicRemediation.actionType}</code>
                          <div className="meta">{control.systemicRemediation.rationale}</div>
                        </>
                      ) : (
                        <span className="meta">No automated remediation available</span>
                      )}
                    </td>
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
