import {
  BLOCKED_REASON_OF_FAILURE,
  DEGRADED_REASON_OF_FAILURE,
  type BlockedReason,
  type CollectionFailureCode,
  type DegradedReason,
} from '@adericel/domain';
import type { ConnectorManifest } from './manifest.js';

/**
 * What a broken source does to assurance.
 *
 * WHY THIS IS NEEDED AT ALL
 *
 * The Truth Engine performs no I/O and reads no clock, so it cannot ask
 * whether a connector is healthy. It accepts impairment as input and applies
 * one safety rule: impairment may only ever convert UNKNOWN into DEGRADED or
 * BLOCKED, never touch a real determination. That rule was written, tested and
 * then never exercised, because nothing supplied the input — which meant
 * DEGRADED was unreachable through assessment and a control whose source had
 * broken reported UNKNOWN / INSUFFICIENT_EVIDENCE.
 *
 * The difference is the whole value of the state. INSUFFICIENT_EVIDENCE tells
 * an engineer to connect something; what actually happened is that the Entra
 * credential expired. One of those sentences gets the estate observable again
 * and the other sends somebody to re-do work that is already done.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not decide any control's state, and it must not. It says "these
 * predicates cannot currently be collected, and here is why in words an
 * operator can act on". Whether that costs Adericel a determination is the
 * engine's judgement, made against the claims actually held — which is why a
 * source can be entirely dead while a control it feeds stays SATISFIED on
 * evidence still inside its freshness window. That is the correct answer, and
 * the connector health surface is where the broken source is reported in the
 * meantime.
 *
 * The shape matches `PredicateImpairment` in the Truth Engine, which is
 * deliberately not imported: the engine must not depend on connectors, and
 * connectors must not depend on the engine. `packages/containment` keeps the
 * same shape for the same reason, and asserts it by test.
 */
export interface SourceImpairment {
  readonly predicate: string;
  readonly kind: 'DEGRADED' | 'BLOCKED';
  readonly reason: DegradedReason | BlockedReason;
  readonly detail: string;
}

/** Integration statuses that mean collection is not currently working. */
const UNHEALTHY_STATUSES = new Set(['DEGRADED', 'FAILED', 'DISCONNECTED', 'REVOKED']);

/**
 * One integration, as the assessment path sees it.
 *
 * `latestFailureCode` is the code recorded on its most recent failed run. It
 * is nullable because an integration can be unhealthy without a classified
 * failure — a run still in flight, or a database restored from before
 * classification existed — and in that case the honest answer is the most
 * general degraded reason rather than a guess.
 */
export interface IntegrationHealthFacts {
  readonly integrationId: string;
  readonly name: string;
  readonly connectorKey: string;
  readonly status: string;
  readonly latestFailureCode: CollectionFailureCode | null;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: string | null;
  /**
   * The predicates this integration supplies.
   *
   * Carried per integration rather than looked up by connector key, because
   * two integrations in one organisation can share a connector — two Microsoft
   * 365 tenants, two RMM instances — and a lookup by key would attribute one
   * instance's predicates to the other. It also lets the caller take the union
   * of what the manifest declares and what this integration has actually
   * answered, which is where the ground truth is.
   */
  readonly predicates: readonly string[];
}

/** Every predicate a connector's collect capabilities declare. */
export function predicatesOf(manifest: ConnectorManifest): readonly string[] {
  return [...new Set((manifest.collect ?? []).flatMap((capability) => capability.predicates))];
}

function detailFor(facts: IntegrationHealthFacts, code: CollectionFailureCode | null): string {
  const since =
    facts.lastSuccessAt === null
      ? 'It has never collected successfully.'
      : `It last collected successfully at ${facts.lastSuccessAt}.`;
  const attempts =
    facts.consecutiveFailures === 1
      ? 'One attempt has failed.'
      : `${facts.consecutiveFailures} consecutive attempts have failed.`;
  const classification =
    code === null
      ? 'The failure has not been classified, so the repair is not yet known.'
      : `The connector reported ${code}.`;
  return (
    `The integration "${facts.name}" (${facts.connectorKey}) is ${facts.status}. ` +
    `${classification} ${attempts} ${since}`
  );
}

/**
 * Impairments for every predicate an unhealthy integration can no longer
 * supply.
 *
 * Returns empty for a healthy integration, which is the common case and the
 * one worth being certain about: a working connector must not degrade a single
 * control.
 *
 * An integration with no classified failure still produces an impairment. The
 * alternative — stay silent until a code is known — would mean the first
 * minutes of every outage look identical to normal operation, and those are
 * the minutes in which somebody could still act.
 */
export function sourceImpairments(input: {
  readonly integrations: readonly IntegrationHealthFacts[];
}): readonly SourceImpairment[] {
  const out: SourceImpairment[] = [];

  for (const facts of input.integrations) {
    if (!UNHEALTHY_STATUSES.has(facts.status)) continue;
    if (facts.predicates.length === 0) continue;

    const code = facts.latestFailureCode;
    // A withdrawn consent needs somebody with authority, not an engineer, so it
    // routes BLOCKED. Everything else is a repair an engineer can carry out.
    const blocked = code === null ? null : BLOCKED_REASON_OF_FAILURE[code];
    const reason: DegradedReason | BlockedReason =
      blocked ?? (code === null ? 'COLLECTION_FAILING' : DEGRADED_REASON_OF_FAILURE[code]);
    const kind: 'DEGRADED' | 'BLOCKED' = blocked === null ? 'DEGRADED' : 'BLOCKED';
    const detail = detailFor(facts, code);

    for (const predicate of facts.predicates) {
      out.push({ predicate, kind, reason, detail });
    }
  }

  /**
   * Deterministic order.
   *
   * The engine puts impairments inside the assessment digest, so two runs over
   * the same facts must produce the same bytes or replay stops matching. A map
   * iteration order that happens to be stable today is not a guarantee.
   */
  return [...out].sort(
    (a, b) =>
      a.predicate.localeCompare(b.predicate) ||
      a.kind.localeCompare(b.kind) ||
      a.reason.localeCompare(b.reason) ||
      a.detail.localeCompare(b.detail),
  );
}

/**
 * The `predicatesForConnector` lookup the assessment service requires, backed
 * by a registry.
 *
 * A connector key stored against an integration may no longer be registered —
 * a connector withdrawn in a later release, a database restored from an older
 * one. `tryGet` rather than `get` so that reports an integration with no
 * predicates instead of throwing: an unknown connector must not stop a whole
 * organisation being assessed.
 */
export function predicatesForConnectorFrom(registry: {
  tryGet(key: string): { manifest: ConnectorManifest } | null;
}): (connectorKey: string) => readonly string[] {
  const cache = new Map<string, readonly string[]>();
  return (connectorKey) => {
    const cached = cache.get(connectorKey);
    if (cached) return cached;
    const connector = registry.tryGet(connectorKey);
    const predicates = connector === null ? [] : predicatesOf(connector.manifest);
    cache.set(connectorKey, predicates);
    return predicates;
  };
}
