import type { PlatformContext } from '@adericel/graph';

/**
 * What Adericel actually did.
 *
 * Every number in this file is a count of rows somebody can go and look at.
 * None of it is modelled, inferred, extrapolated or annualised. That is the
 * whole point: this is the half of the proof-of-value case that Adericel is
 * entitled to assert, because it is the half Adericel observed.
 *
 * The other half — what that work is worth in an MSP's money — belongs to the
 * MSP and lives in `effort.ts`. Keeping them in separate files is not
 * fastidiousness. It is so that nobody can later add a plausible default to one
 * and have it silently become a claim about the other.
 *
 * WHAT IS DELIBERATELY NOT COUNTED
 *
 * Work Adericel attempted and did not finish. An action dispatched whose
 * outcome was never established is not a remediation, and counting it would be
 * the same failure as recording ACTION ATTEMPTED as REMEDIATED. It appears in
 * `remediationsUnverified`, separately, where it argues against the product
 * rather than for it — which is where an honest number belongs.
 */

export interface LedgerWindow {
  readonly from: string;
  readonly to: string;
}

export interface OperationalLedger extends LedgerWindow {
  readonly organisationIds: readonly string[];

  // --- Observation -------------------------------------------------------
  /** Observations recorded from a connector, without a person. */
  readonly observationsCollected: number;
  /** Evidence items produced automatically. */
  readonly evidenceCollectedAutomatically: number;
  /** Evidence a person had to upload or attest. Counts against Adericel. */
  readonly evidenceSuppliedByHuman: number;

  // --- Establishing what is true ----------------------------------------
  readonly claimsAsserted: number;
  /** Claims that replaced an earlier claim: something in the estate moved. */
  readonly changesDetected: number;
  /** Claims held DISPUTED because sources disagreed. Not a determination. */
  readonly conflictsRefused: number;

  // --- Determining assurance --------------------------------------------
  readonly controlDeterminations: number;
  /** Determinations where the state actually changed. The impact analysis. */
  readonly assuranceTransitions: number;
  /** Determinations that answered UNKNOWN. Honest, and not free. */
  readonly determinationsUnknown: number;

  // --- Acting ------------------------------------------------------------
  readonly findingsRaised: number;
  readonly remediationsProposed: number;
  /** Executed under policy with no human in the loop. */
  readonly remediationsAutonomous: number;
  /** Executed, but a person had to approve first. Still MSP time. */
  readonly remediationsApproved: number;
  /** Dispatched, outcome never established. Argues against, and is counted. */
  readonly remediationsUnverified: number;
  readonly remediationsFailed: number;

  // --- Proving it ---------------------------------------------------------
  readonly verificationsPerformed: number;
  readonly verificationsConfirmed: number;
  /** Verification that contradicted the action. The product working. */
  readonly verificationsRefuted: number;

  // --- Answering for it ---------------------------------------------------
  readonly passportsIssued: number;
  /** A third party opened a shared assurance record. An enquiry not fielded. */
  readonly assuranceEnquiriesAnswered: number;
}

function count(value: string | null | undefined): number {
  return Number(value ?? '0');
}

/**
 * Build the ledger for a set of organisations over a window.
 *
 * Runs in platform scope because an MSP-level figure spans organisations, and
 * the caller is responsible for having proved the MSP owns every one of them
 * before asking. The route does that; this function does arithmetic.
 */
export async function buildLedger(
  ctx: PlatformContext,
  organisationIds: readonly string[],
  window: LedgerWindow,
): Promise<OperationalLedger> {
  const ids = [...organisationIds];
  const empty: OperationalLedger = {
    ...window,
    organisationIds: ids,
    observationsCollected: 0,
    evidenceCollectedAutomatically: 0,
    evidenceSuppliedByHuman: 0,
    claimsAsserted: 0,
    changesDetected: 0,
    conflictsRefused: 0,
    controlDeterminations: 0,
    assuranceTransitions: 0,
    determinationsUnknown: 0,
    findingsRaised: 0,
    remediationsProposed: 0,
    remediationsAutonomous: 0,
    remediationsApproved: 0,
    remediationsUnverified: 0,
    remediationsFailed: 0,
    verificationsPerformed: 0,
    verificationsConfirmed: 0,
    verificationsRefuted: 0,
    passportsIssued: 0,
    assuranceEnquiriesAnswered: 0,
  };
  if (ids.length === 0) return empty;

  const params = [ids, window.from, window.to];

  const observations = await ctx.one<{ collected: string }>(
    `SELECT count(*)::text AS collected FROM observations
      WHERE organisation_id = ANY($1::uuid[]) AND observed_at > $2 AND observed_at <= $3`,
    params,
  );

  const evidence = await ctx.one<{ automated: string; human: string }>(
    `SELECT count(*) FILTER (
              WHERE collection_method IN ('AUTOMATED_PULL','AUTOMATED_PUSH','WEBHOOK','DERIVED')
            )::text AS automated,
            count(*) FILTER (
              WHERE collection_method IN ('HUMAN_UPLOAD','HUMAN_ATTESTATION')
            )::text AS human
       FROM evidence
      WHERE organisation_id = ANY($1::uuid[]) AND collected_at > $2 AND collected_at <= $3`,
    params,
  );

  const claims = await ctx.one<{ asserted: string; superseding: string; disputed: string }>(
    `SELECT count(*)::text AS asserted,
            count(*) FILTER (WHERE supersedes_claim_id IS NOT NULL)::text AS superseding,
            count(*) FILTER (WHERE status = 'DISPUTED')::text AS disputed
       FROM claims
      WHERE organisation_id = ANY($1::uuid[]) AND asserted_at > $2 AND asserted_at <= $3`,
    params,
  );

  const determinations = await ctx.one<{ total: string; unknown: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE state = 'UNKNOWN')::text AS unknown
       FROM assessments
      WHERE organisation_id = ANY($1::uuid[]) AND assessed_at > $2 AND assessed_at <= $3`,
    params,
  );

  const transitions = await ctx.one<{ moved: string }>(
    `SELECT count(*)::text AS moved FROM assurance_states
      WHERE organisation_id = ANY($1::uuid[])
        AND previous_state IS NOT NULL AND previous_state <> state
        AND since > $2 AND since <= $3`,
    params,
  );

  const findings = await ctx.one<{ raised: string }>(
    `SELECT count(*)::text AS raised FROM findings
      WHERE organisation_id = ANY($1::uuid[])
        AND first_detected_at > $2 AND first_detected_at <= $3`,
    params,
  );

  /**
   * The distinction the whole commercial case rests on.
   *
   * `approval_id IS NULL` means policy permitted the change unattended: nobody
   * was interrupted. `approval_id IS NOT NULL` means a person had to look at
   * it, and that time is the MSP's, so it is counted separately and appears in
   * the residual rather than the saving.
   */
  const actions = await ctx.one<{
    proposed: string;
    autonomous: string;
    approved: string;
    unverified: string;
    failed: string;
  }>(
    `SELECT count(*)::text AS proposed,
            count(*) FILTER (
              WHERE state = 'CONFIRMED' AND approval_id IS NULL
            )::text AS autonomous,
            count(*) FILTER (
              WHERE state = 'CONFIRMED' AND approval_id IS NOT NULL
            )::text AS approved,
            count(*) FILTER (WHERE state = 'UNVERIFIED')::text AS unverified,
            count(*) FILTER (WHERE state IN ('FAILED','TIMED_OUT'))::text AS failed
       FROM actions
      WHERE organisation_id = ANY($1::uuid[]) AND proposed_at > $2 AND proposed_at <= $3`,
    params,
  );

  const verifications = await ctx.one<{ performed: string; confirmed: string; refuted: string }>(
    `SELECT count(*)::text AS performed,
            count(*) FILTER (WHERE outcome = 'CONFIRMED')::text AS confirmed,
            count(*) FILTER (WHERE outcome = 'REFUTED')::text AS refuted
       FROM verifications
      WHERE organisation_id = ANY($1::uuid[]) AND verified_at > $2 AND verified_at <= $3`,
    params,
  );

  const passports = await ctx.one<{ issued: string }>(
    `SELECT count(*)::text AS issued FROM assurance_passports
      WHERE organisation_id = ANY($1::uuid[]) AND issued_at > $2 AND issued_at <= $3`,
    params,
  );

  const views = await ctx.one<{ opened: string }>(
    `SELECT count(*)::text AS opened FROM passport_share_views
      WHERE organisation_id = ANY($1::uuid[]) AND viewed_at > $2 AND viewed_at <= $3`,
    params,
  );

  return {
    ...window,
    organisationIds: ids,
    observationsCollected: count(observations?.collected),
    evidenceCollectedAutomatically: count(evidence?.automated),
    evidenceSuppliedByHuman: count(evidence?.human),
    claimsAsserted: count(claims?.asserted),
    changesDetected: count(claims?.superseding),
    conflictsRefused: count(claims?.disputed),
    controlDeterminations: count(determinations?.total),
    assuranceTransitions: count(transitions?.moved),
    determinationsUnknown: count(determinations?.unknown),
    findingsRaised: count(findings?.raised),
    remediationsProposed: count(actions?.proposed),
    remediationsAutonomous: count(actions?.autonomous),
    remediationsApproved: count(actions?.approved),
    remediationsUnverified: count(actions?.unverified),
    remediationsFailed: count(actions?.failed),
    verificationsPerformed: count(verifications?.performed),
    verificationsConfirmed: count(verifications?.confirmed),
    verificationsRefuted: count(verifications?.refuted),
    passportsIssued: count(passports?.issued),
    assuranceEnquiriesAnswered: count(views?.opened),
  };
}
