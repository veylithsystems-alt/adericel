import { bearer } from '../../tests/helpers/harness.js';
import { applyConditions, type ProofCustomer, type ProofPortfolio } from './portfolio.js';

/**
 * The operating cycle, run across the whole portfolio.
 *
 * Observe, determine, detect change, propose, approve, execute, re-observe,
 * verify. Every step goes through the HTTP API, because the claim being
 * demonstrated is about the product, not about the modules underneath it.
 *
 * Two cycles are run. The first establishes the picture; the second is where
 * change detection has something to detect, which is the only way to
 * demonstrate it honestly — a change detector that is handed a change it
 * already knows about is proving nothing.
 */

export interface CycleTiming {
  readonly label: string;
  readonly milliseconds: number;
  readonly organisations: number;
}

export interface ScenarioResult {
  readonly timings: readonly CycleTiming[];
  readonly collectionFailures: number;
  readonly remediationsProposed: number;
  readonly remediationsApproved: number;
  readonly remediationsExecuted: number;
  readonly verificationsRun: number;
}

async function timed<T>(
  label: string,
  organisations: number,
  fn: () => Promise<T>,
): Promise<{ value: T; timing: CycleTiming }> {
  const started = Date.now();
  const value = await fn();
  return {
    value,
    timing: { label, milliseconds: Date.now() - started, organisations },
  };
}

/** Collect and assess one customer. Errors are counted, never swallowed. */
async function observeAndAssess(
  portfolio: ProofPortfolio,
  customer: ProofCustomer,
): Promise<boolean> {
  const { harness, operatorToken } = portfolio;
  const { organisationId, integrationId } = customer.tenant;

  const collected = await harness.server.inject({
    method: 'POST',
    url: `/v1/organisations/${organisationId}/integrations/${integrationId}/collect`,
    headers: bearer(operatorToken),
  });
  // A customer with no connector cannot be collected from, and that is the
  // condition being demonstrated rather than a failure of the run.
  const collectionOk = collected.statusCode === 200 || customer.archetype.noConnector === true;

  const assessed = await harness.server.inject({
    method: 'POST',
    url: `/v1/organisations/${organisationId}/assessments/run-all`,
    headers: bearer(operatorToken),
    payload: {},
  });

  return collectionOk && (assessed.statusCode === 201 || assessed.statusCode === 200);
}

/**
 * Propose, authorise and verify remediation for one customer.
 *
 * Whether an approval is required is the policy's decision, not this function's.
 * Both paths are exercised because both happen, and the difference between them
 * is exactly what the workload measurement turns on.
 */
async function remediate(
  portfolio: ProofPortfolio,
  customer: ProofCustomer,
  counters: { proposed: number; approved: number; executed: number; verified: number },
): Promise<void> {
  const { harness, operatorToken, approverToken } = portfolio;
  const { organisationId, integrationId } = customer.tenant;
  const archetype = customer.archetype;

  const findings = await harness.server.inject({
    method: 'GET',
    url: `/v1/organisations/${organisationId}/findings?status=OPEN&limit=5`,
    headers: bearer(operatorToken),
  });
  if (findings.statusCode !== 200) return;

  const open = (findings.json() as { findings: { id: string; title: string }[] }).findings;
  if (open.length === 0) return;

  // One remediation per customer. The point is to exercise the lifecycle, not
  // to produce the largest possible action count.
  const subject = `${customer.slug}-user-0`;
  const nodes = await harness.server.inject({
    method: 'GET',
    url: `/v1/organisations/${organisationId}/nodes?kind=Identity&externalId=${subject}`,
    headers: bearer(operatorToken),
  });
  const nodeId = (nodes.json() as { nodes: { id: string }[] }).nodes[0]?.id;
  if (!nodeId) return;

  const proposed = await harness.server.inject({
    method: 'POST',
    url: `/v1/organisations/${organisationId}/actions`,
    headers: bearer(operatorToken),
    payload: {
      actionType: 'identity.mfa.require',
      integrationId,
      targetNodeId: nodeId,
      targetExternalId: subject,
      parameters: { enforcement: 'REQUIRED' },
      rationale: 'Identity has no second factor enforced.',
    },
  });
  if (proposed.statusCode !== 201 && proposed.statusCode !== 202) return;
  counters.proposed += 1;

  const action = (proposed.json() as { action: { id: string; state: string } }).action;

  // A customer whose archetype is "waiting on a human" is left waiting. That is
  // the state being demonstrated, and completing it would erase it.
  if (archetype.key === 'REMEDIATION_NEEDS_APPROVAL') return;

  if (action.state === 'AWAITING_APPROVAL') {
    const decided = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${organisationId}/actions/${action.id}/decision`,
      headers: bearer(approverToken),
      payload: { decision: 'APPROVED', note: 'Required by the baseline.' },
    });
    if (decided.statusCode === 200) counters.approved += 1;
  }

  if (archetype.remediationFails === true) {
    // Make the upstream reject the change, so the execution genuinely fails
    // rather than being recorded as failed.
    harness.fixtureState.apply(integrationId, subject, { __failExecution: true });
  }

  const executed = await harness.server.inject({
    method: 'POST',
    url: `/v1/organisations/${organisationId}/actions/${action.id}/execute`,
    headers: bearer(operatorToken),
    payload: {},
  });
  if (executed.statusCode === 200) counters.executed += 1;

  if (archetype.verificationFails === true) {
    // The action succeeded and the estate says otherwise. Re-observation must
    // contradict the action record, and the product must believe the estate.
    harness.fixtureState.apply(integrationId, subject, { mfaEnforced: false });
  }

  const verified = await harness.server.inject({
    method: 'POST',
    url: `/v1/organisations/${organisationId}/actions/${action.id}/verify`,
    headers: bearer(operatorToken),
    payload: {},
  });
  if (verified.statusCode === 200) counters.verified += 1;

  // A customer whose control keeps coming back: break it again, so the queue
  // has a genuine recurrence rather than a flag somebody set.
  if (archetype.recurrence !== undefined) {
    for (let i = 0; i < archetype.recurrence; i += 1) {
      harness.fixtureState.apply(integrationId, subject, { mfaEnforced: false });
      await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${organisationId}/integrations/${integrationId}/collect`,
        headers: bearer(operatorToken),
      });
      await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${organisationId}/assessments/run-all`,
        headers: bearer(operatorToken),
        payload: {},
      });
    }
  }
}

/** Begin offboarding for the customers whose archetype is leaving. */
async function beginOffboarding(portfolio: ProofPortfolio): Promise<void> {
  const { harness, operatorToken } = portfolio;
  for (const customer of portfolio.customers) {
    if (customer.archetype.offboarding !== true) continue;
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${customer.tenant.organisationId}/offboarding`,
      headers: bearer(operatorToken),
      payload: { reason: 'Customer has moved to another provider.' },
    });
    // Deliberately stopped part-way: no export, no revocation, no closure.
    // That is the condition the exception queue has to notice.
  }
}

export async function runScenario(
  portfolio: ProofPortfolio,
  options: { quiet?: boolean } = {},
): Promise<ScenarioResult> {
  const log = (message: string): void => {
    if (!options.quiet) process.stdout.write(`${message}\n`);
  };

  const timings: CycleTiming[] = [];
  const counters = { proposed: 0, approved: 0, executed: 0, verified: 0 };
  let collectionFailures = 0;

  log('Cycle 1: establishing the picture…');
  const first = await timed(
    'first observation and assessment',
    portfolio.customers.length,
    async () => {
      let failures = 0;
      for (const customer of portfolio.customers) {
        const ok = await observeAndAssess(portfolio, customer);
        if (!ok) failures += 1;
      }
      return failures;
    },
  );
  collectionFailures += first.value;
  timings.push(first.timing);

  log('Applying portfolio conditions…');
  await applyConditions(portfolio);

  log('Remediating where a finding exists…');
  const remediation = await timed('remediation lifecycle', portfolio.customers.length, async () => {
    for (const customer of portfolio.customers) {
      await remediate(portfolio, customer, counters);
    }
  });
  timings.push(remediation.timing);

  log('Cycle 2: re-observing, so change detection has something to detect…');
  const second = await timed(
    'second observation and assessment',
    portfolio.customers.length,
    async () => {
      let failures = 0;
      for (const customer of portfolio.customers) {
        // A customer deliberately aged into staleness is left alone: collecting
        // from them again would cure the condition being demonstrated.
        if (customer.archetype.staleByDays !== undefined) continue;
        const ok = await observeAndAssess(portfolio, customer);
        if (!ok) failures += 1;
      }
      return failures;
    },
  );
  collectionFailures += second.value;
  timings.push(second.timing);

  await beginOffboarding(portfolio);

  return {
    timings,
    collectionFailures,
    remediationsProposed: counters.proposed,
    remediationsApproved: counters.approved,
    remediationsExecuted: counters.executed,
    verificationsRun: counters.verified,
  };
}
