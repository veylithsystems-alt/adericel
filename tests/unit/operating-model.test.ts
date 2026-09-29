import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_STATE_MEANINGS,
  CLIENT_APPROVAL_POINTS,
  COMMERCIAL_STATES,
  ESCALATION_PATHS,
  EVIDENCE_OWNERSHIP,
  OPERATING_ACTORS,
  OPERATING_PARTIES,
  PERMISSION_CLASS,
  REVIEW_RESPONSIBILITIES,
  ROLE_PERMISSIONS,
  ROLES_VALID_IN_SCOPE,
  SURFACE_DEFINITIONS,
  operatingModelDiscrepancies,
  scopeForSurface,
  type Role,
} from '@adericel/domain';

/**
 * The operating model, checked against the system it describes.
 *
 * An MSP plans their business around this: who owns the evidence, who reviews
 * what, where an escalation goes, what the client must approve. A document
 * would be true on the day it was written and would then quietly reassure
 * everybody about a system that had moved on.
 *
 * So it is declared as data and verified here. The generated document under
 * `docs/product/` is a view of the system rather than a claim about it.
 */

describe('the model describes the system that exists', () => {
  it('has no discrepancy between what an actor claims and what their role holds', () => {
    // The single assertion that makes the model trustworthy. An actor claiming
    // to decide something their role cannot is an operating model that would
    // have an MSP planning around authority nobody has.
    expect(operatingModelDiscrepancies()).toEqual([]);
  });

  it('names only roles the authority model defines', () => {
    for (const actor of OPERATING_ACTORS) {
      expect(ROLE_PERMISSIONS[actor.role], actor.key).toBeDefined();
    }
  });

  it('puts every actor on a surface their role is valid on', () => {
    /**
     * The tenancy design in one assertion. An MSP engineer works the MSP
     * surface; a client’s staff work the client surface; a Veylith
     * administrator works neither. A model that placed an actor on a surface
     * their grants are invisible on would describe access they do not have.
     */
    for (const actor of OPERATING_ACTORS) {
      const scope = scopeForSurface(actor.surface);
      const valid = ROLES_VALID_IN_SCOPE[scope] as readonly Role[];
      expect(valid, `${actor.key} on ${actor.surface}`).toContain(actor.role);
    }
  });

  it('names only real permissions in every solo decision', () => {
    for (const actor of OPERATING_ACTORS) {
      for (const permission of actor.decidesAlone) {
        expect(PERMISSION_CLASS[permission], `${actor.key}/${permission}`).toBeDefined();
      }
    }
  });

  it('covers every commercial state, so a new one cannot appear unexplained', () => {
    const explained = ACCOUNT_STATE_MEANINGS.map((meaning) => meaning.state);
    expect([...explained].sort()).toEqual([...COMMERCIAL_STATES].sort());
  });
});

describe('the boundaries the model exists to state', () => {
  it('gives Veylith no route to client assurance data', () => {
    /**
     * The claim an MSP will check hardest, and the one that has to be true in
     * the code rather than in a sentence. Asserted twice: the actor’s own
     * "never does", and the surface model underneath it.
     */
    const veylith = OPERATING_ACTORS.find((actor) => actor.key === 'veylith.platform')!;
    expect(veylith.neverDoes.join(' ')).toMatch(/honoured on neither Adericel surface/i);
    expect(SURFACE_DEFINITIONS.VEYLITH_INTERNAL.reads).not.toContain('TENANT_ASSURANCE');
    expect(SURFACE_DEFINITIONS.VEYLITH_INTERNAL.reads).not.toContain('TENANT_ADMINISTRATION');
  });

  it('leaves every piece of evidence with the client', () => {
    // The offboarding promise, stated per source kind rather than once in
    // prose. A customer leaves with their record (ADR-0030).
    for (const ownership of EVIDENCE_OWNERSHIP) {
      expect(ownership.describes, ownership.sourceKind).toBe('CLIENT');
      expect(ownership.leavesWith, ownership.sourceKind).toBe('CLIENT');
      expect(ownership.readableBy, ownership.sourceKind).toContain('CLIENT');
    }
  });

  it('never lets Veylith read routine evidence', () => {
    for (const ownership of EVIDENCE_OWNERSHIP) {
      expect(ownership.readableBy, ownership.sourceKind).not.toContain('VEYLITH');
    }
  });

  it('routes a client to their MSP by default, with security as the stated exception', () => {
    const fromClient = ESCALATION_PATHS.filter((path) => path.from === 'CLIENT');
    const toMsp = fromClient.filter((path) => path.to === 'MSP');
    const toVeylith = fromClient.filter((path) => path.to === 'VEYLITH');

    expect(toMsp.length).toBeGreaterThan(0);
    expect(toMsp[0]!.about).toMatch(/anything at all, by default/i);
    // Exactly one exception, and it is security. More than one would mean the
    // boundary has become a guideline.
    expect(toVeylith).toHaveLength(1);
    expect(toVeylith[0]!.about).toMatch(/security concern, and nothing else/i);
  });

  it('says of every review whether the system enforces it or merely shows it', () => {
    /**
     * The distinction an MSP needs and most vendors blur. "Exceptions are
     * reviewed" reads as a control; if nothing stops an unreviewed exception
     * expiring, it is a reminder. Both are useful and they are not the same
     * promise.
     */
    for (const review of REVIEW_RESPONSIBILITIES) {
      expect(['ENFORCED', 'SURFACED'], review.what).toContain(review.enforcement);
    }
    expect(REVIEW_RESPONSIBILITIES.some((review) => review.enforcement === 'ENFORCED')).toBe(true);
    expect(REVIEW_RESPONSIBILITIES.some((review) => review.enforcement === 'SURFACED')).toBe(true);
  });

  it('gives a reason for every point the client has to approve', () => {
    // An approval gate with no stated reason becomes a step somebody removes
    // to speed things up.
    for (const point of CLIENT_APPROVAL_POINTS) {
      expect(point.why.length, point.what).toBeGreaterThan(40);
    }
  });

  it('ships the direct-support agreement granted to nobody, and says so here too', () => {
    const direct = CLIENT_APPROVAL_POINTS.find((point) => point.what.includes('Direct support'))!;
    expect(direct.why).toMatch(/granted to nobody/i);
    expect(direct.why).toMatch(/structurally cannot go round them/i);
  });
});

describe('every party and every actor accounted for', () => {
  it('assigns each actor to one of the four parties', () => {
    for (const actor of OPERATING_ACTORS) {
      expect(OPERATING_PARTIES, actor.key).toContain(actor.party);
    }
  });

  it('gives each actor something they are accountable for and something they never do', () => {
    for (const actor of OPERATING_ACTORS) {
      expect(actor.accountableFor.length, actor.key).toBeGreaterThan(40);
      expect(actor.neverDoes.length, actor.key).toBeGreaterThan(0);
    }
  });

  it('represents the MSP, the client and Veylith', () => {
    const parties = new Set(OPERATING_ACTORS.map((actor) => actor.party));
    expect(parties.has('MSP')).toBe(true);
    expect(parties.has('CLIENT')).toBe(true);
    expect(parties.has('VEYLITH')).toBe(true);
  });
});
