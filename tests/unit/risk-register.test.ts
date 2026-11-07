import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The register may not contradict itself.
 *
 * Seven entries said `**CLOSED <date>**` in the heading and `OPEN` in the
 * `State` row, with no evidence of either (RR-094). The headings had been
 * annotated when the work landed; the rows had not. Nothing noticed, because
 * nothing reads this file.
 *
 * That matters more here than it would in most documents. This register is the
 * artefact that says Adericel distinguishes what was measured from what was
 * asserted. An auditor who finds it disagreeing with itself about whether a
 * risk is live is entitled to discount everything else in it — and would be
 * right to, because the contradiction is evidence that nobody checks.
 *
 * So the register gets the same treatment as the code: a mechanical check, and
 * each part of it proved by deliberate breakage (mutations
 * `register-heading-contradicts-state`, `register-closure-without-evidence`,
 * `register-dangling-cross-reference`).
 *
 * WHAT THIS CHECK CANNOT DO
 *
 * It verifies that a closure cites evidence, never that the evidence is true.
 * An entry closed with a `Verified` row naming a test that does not exist
 * would satisfy every assertion below but the path check. That is the honest
 * limit, and it is why the cross-reference and path checks exist at all.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const REGISTER = join(ROOT, 'docs', 'audit', 'RESIDUAL_RISK_REGISTER.md');

/** The states an entry may be in, as the register's own preamble defines them. */
const ACCEPTANCE_STATES = ['OPEN', 'MITIGATING', 'ACCEPTED', 'CLOSED', 'WITHDRAWN'] as const;
type AcceptanceState = (typeof ACCEPTANCE_STATES)[number];

/**
 * A row whose presence counts as citing evidence for a closure.
 *
 * Deliberately a closed list rather than "any row with prose in it". An entry
 * closed on the strength of its `Mitigation` row alone is closed on a plan,
 * which is the thing the register's preamble forbids: "An entry leaves this
 * register when the mitigation is implemented **and** evidenced, not when it
 * is planned." `Mitigation` is therefore not in this list; `Mitigation
 * applied` is.
 */
const EVIDENCE_ROWS = [
  'Verified',
  'Evidence',
  'Proved by',
  'Measured',
  'Guard proved',
  'Mitigation applied',
  'Resolution',
] as const;

interface Entry {
  readonly id: string;
  readonly heading: string;
  /** The state asserted by the heading's `**CLOSED ...**` annotation, if any. */
  readonly headingClaimsClosed: boolean;
  /** The state in the `State` row, or null if there is no such row. */
  readonly state: AcceptanceState | null;
  readonly rows: readonly string[];
  readonly body: string;
}

function parseEntries(markdown: string): readonly Entry[] {
  // Split on the entry headings, keeping the id and the rest of the heading.
  const parts = markdown.split(/\n### (RR-\d+)([^\n]*)\n/);
  const entries: Entry[] = [];
  for (let i = 1; i + 2 < parts.length + 1; i += 3) {
    const id = parts[i];
    const heading = parts[i + 1] ?? '';
    const body = parts[i + 2] ?? '';
    const rows = [...body.matchAll(/^\|\s*\*\*([^*|]+)\*\*\s*\|/gm)].map((m) => m[1].trim());
    const stateCell = /^\|\s*\*\*State\*\*\s*\|([^|]*)\|/m.exec(body)?.[1] ?? null;
    const state =
      stateCell === null
        ? null
        : (ACCEPTANCE_STATES.find((candidate) =>
            // The cell may carry prose after the state ("`CLOSED` — supersedes
            // RR-011"), so the state is the first word, not the whole cell.
            new RegExp(`^\\s*\`?${candidate}\`?\\b`).test(stateCell),
          ) ?? null);
    entries.push({
      id,
      heading: heading.trim(),
      headingClaimsClosed: /\bCLOSED\b/.test(heading),
      state,
      rows,
      body,
    });
  }
  return entries;
}

describe('the residual risk register', () => {
  const markdown = readFileSync(REGISTER, 'utf8');
  const entries = parseEntries(markdown);

  it('has entries to check at all', () => {
    // The premise. Every assertion below is a loop over `entries`, so a parser
    // that silently matched nothing would make the whole file vacuous — the
    // failure mode that shipped in the chaos suite (RR-081) and in the
    // mutation harness (RR-092).
    expect(entries.length, 'the register parsed to no entries at all').toBeGreaterThan(50);
  });

  it('gives every entry a state from the four the preamble defines', () => {
    const bad = entries
      .filter((entry) => entry.state === null)
      .map((entry) => `${entry.id} (${entry.heading})`);
    expect(
      bad,
      'these entries have no State row, or one naming a state that is not defined',
    ).toEqual([]);
  });

  it('never lets a heading contradict the state it records', () => {
    /**
     * The defect this file was written for. A heading saying CLOSED over a row
     * saying OPEN is not a typo: it is two different answers to "is this risk
     * live", and a reader has no way to know which is current.
     */
    const contradictory = entries
      .filter((entry) => entry.headingClaimsClosed && entry.state !== 'CLOSED')
      .map((entry) => `${entry.id}: heading says CLOSED, State says ${entry.state}`);
    expect(contradictory, 'heading and State disagree').toEqual([]);
  });

  it('never closes an entry without citing evidence', () => {
    /**
     * Per the register's own preamble. A `CLOSED` entry whose only
     * forward-looking row is `Mitigation` is closed on a plan, and a plan is
     * the thing that was there before the work.
     */
    const unevidenced = entries
      .filter((entry) => entry.state === 'CLOSED')
      .filter((entry) => !entry.rows.some((row) => EVIDENCE_ROWS.includes(row as never)))
      .map((entry) => `${entry.id} (${entry.heading})`);
    expect(
      unevidenced,
      `these entries are CLOSED but cite none of: ${EVIDENCE_ROWS.join(', ')}`,
    ).toEqual([]);
  });

  it('gives every live entry an owner', () => {
    // An OPEN risk nobody owns is not tracked, it is merely written down. The
    // owner may be the founder rather than engineering — several are, and must
    // be — but it may not be absent.
    const unowned = entries
      .filter((entry) => entry.state === 'OPEN' || entry.state === 'MITIGATING')
      .filter((entry) => !entry.rows.includes('Owner'))
      .map((entry) => `${entry.id} (${entry.heading})`);
    expect(unowned, 'these entries are live and name no owner').toEqual([]);
  });

  it('never withdraws an entry without saying what replaced it', () => {
    /**
     * RR-011's heading said "WITHDRAWN, superseded by RR-061" while its State
     * row said `OPEN`, which is how it survived every earlier reading. A
     * withdrawal is the one state that removes a risk from view without
     * anything having been fixed, so it has to name where the risk went.
     */
    const unexplained = entries
      .filter((entry) => entry.state === 'WITHDRAWN')
      .filter((entry) => !/\bRR-\d{3}\b/.test(entry.body))
      .map((entry) => `${entry.id} (${entry.heading})`);
    expect(unexplained, 'these are withdrawn and name no entry that replaces them').toEqual([]);
  });

  it('uses each identifier exactly once', () => {
    const seen = new Map<string, number>();
    for (const entry of entries) seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1);
    const duplicated = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
    expect(duplicated, 'these identifiers appear more than once').toEqual([]);
    /**
     * Contiguity is deliberately not asserted. Thirty-six numbers below the
     * highest are unused, and why each went unused is not recorded anywhere in
     * this repository, so a contiguity check could only be satisfied by
     * inventing entries. What is asserted is that an identifier is never
     * reused, which is the property that makes a cross-reference meaningful.
     */
  });

  it('never refers to an entry that does not exist', () => {
    /**
     * RR-075's residual read "Tracked as RR-080". There was no RR-080. A
     * residual risk recorded as tracked elsewhere, where elsewhere does not
     * exist, is worse than one recorded as open: it looks handled.
     */
    const defined = new Set(entries.map((entry) => entry.id));
    const referenced = new Set([...markdown.matchAll(/\bRR-(\d{3})\b/g)].map((m) => `RR-${m[1]}`));
    const dangling = [...referenced].filter((id) => !defined.has(id)).sort();
    expect(dangling, 'these are referred to but have no entry of their own').toEqual([]);
  });

  it('names real files wherever it cites one', () => {
    /**
     * The one check that reaches past the document and touches the thing it
     * claims. Evidence given as a path is the commonest kind in this register,
     * and a path that has moved makes the closure unverifiable by the next
     * reader even though it was true when written.
     */
    const cited = new Set(
      [
        ...markdown.matchAll(
          /`((?:tests|packages|apps|scripts|database|docs|infrastructure)\/[A-Za-z0-9_./-]+)`/g,
        ),
      ].map((m) => m[1]),
    );
    const missing = [...cited].filter((relative) => !existsSync(join(ROOT, relative))).sort();
    expect(missing, 'the register cites these paths; they do not exist').toEqual([]);
  });
});
