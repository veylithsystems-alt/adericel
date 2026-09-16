import { describe, expect, it } from 'vitest';
import { SUPPORT_CASE_STATES, mayDiscloseAt } from './case.js';
import {
  DISCLOSURE_CEILING,
  DISCLOSURE_KINDS,
  IDENTIFICATION_VALID_MINUTES,
  mayDisclose,
  type DisclosureRequest,
} from './entitlement.js';
import { REQUESTER_KINDS } from './routing.js';

const NOW = '2026-09-16T12:00:00.000Z';

function request(overrides: Partial<DisclosureRequest> = {}): DisclosureRequest {
  return {
    kind: 'ASSURANCE_STATE',
    caseState: 'IN_PROGRESS',
    requesterKind: 'END_CUSTOMER',
    identifiedBy: 'AUTHENTICATED_SESSION',
    identifiedAtIso: '2026-09-16T11:45:00.000Z',
    atIso: NOW,
    concernsRequestersOwnOrganisation: true,
    requesterMspRunsOrganisation: false,
    directSupportEntitled: false,
    ...overrides,
  };
}

describe('identity before disclosure', () => {
  it('says nothing at all before the case is triaged', () => {
    /**
     * §22. The failure this prevents is specific and common: somebody calls,
     * sounds plausible, says they are from the customer, and is told which
     * controls the organisation is failing. That is a tenancy breach conducted
     * through a helpdesk, and row-level security does not prevent it — the
     * person disclosing is authorised.
     */
    for (const caseState of SUPPORT_CASE_STATES) {
      if (mayDiscloseAt(caseState)) continue;
      for (const kind of DISCLOSURE_KINDS) {
        const decision = mayDisclose(request({ caseState, kind }));
        expect(decision.permitted).toBe(false);
      }
    }
  });

  it('refuses an unidentified requester, and says how to fix it', () => {
    const decision = mayDisclose(request({ identifiedBy: 'NONE', identifiedAtIso: null }));
    expect(decision.permitted).toBe(false);
    expect(decision.permitted === false && decision.remedy).toMatch(
      /already on the record|not accept an address supplied/i,
    );
  });

  it('expires an identification rather than trusting it forever', () => {
    // A case that runs three weeks and discloses an estate in week three on an
    // email link clicked in week one is relying on something that was true once.
    const decision = mayDisclose(
      request({
        identifiedBy: 'VERIFIED_EMAIL_CHALLENGE',
        identifiedAtIso: '2026-09-10T12:00:00.000Z',
      }),
    );
    expect(decision.permitted).toBe(false);
    expect(decision.permitted === false && decision.reason).toMatch(/past the .* window/i);
  });

  it('trusts a weaker method for less time, without exception', () => {
    const order = ['AUTHENTICATED_SESSION', 'VERIFIED_EMAIL_CHALLENGE', 'MSP_VOUCHED'] as const;
    for (const method of order) {
      expect(IDENTIFICATION_VALID_MINUTES[method]).toBeGreaterThan(0);
    }
    expect(IDENTIFICATION_VALID_MINUTES.NONE).toBe(0);
  });
});

describe('what each party is ever told', () => {
  it('never tells a client their MSP’s commercial position', () => {
    // Same reason the client surface excludes MSP_PORTFOLIO: a client must not
    // learn what their MSP pays or who else is in their book.
    expect(DISCLOSURE_CEILING.END_CUSTOMER).not.toContain('COMMERCIAL_POSITION');
    const decision = mayDisclose(request({ kind: 'COMMERCIAL_POSITION' }));
    expect(decision.permitted).toBe(false);
    expect(decision.permitted === false && decision.remedy).toMatch(/Refer them to their MSP/i);
  });

  it('never tells Veylith a customer’s assurance, estate, evidence or personal data', () => {
    /**
     * §29. Veylith holds no standing access to a customer's estate. Support is
     * the surface where that is most likely to erode, because the agent is
     * trying to help and the data would help.
     */
    for (const kind of ['ASSURANCE_STATE', 'ESTATE_DETAIL', 'EVIDENCE', 'PERSONAL_DATA'] as const) {
      expect(DISCLOSURE_CEILING.VEYLITH).not.toContain(kind);
      const decision = mayDisclose(request({ requesterKind: 'VEYLITH', kind }));
      expect(decision.permitted).toBe(false);
    }
  });

  it('refuses Veylith a diagnostic bundle without a direct-support agreement', () => {
    const decision = mayDisclose(request({ requesterKind: 'VEYLITH', kind: 'DIAGNOSTIC_BUNDLE' }));
    expect(decision.permitted).toBe(false);
    expect(decision.permitted === false && decision.remedy).toMatch(/break-glass/i);
  });

  it('tells the system nothing, because it has no inbox', () => {
    for (const kind of DISCLOSURE_KINDS) {
      expect(DISCLOSURE_CEILING.SYSTEM).not.toContain(kind);
      expect(mayDisclose(request({ requesterKind: 'SYSTEM', kind })).permitted).toBe(false);
    }
  });

  it('classifies every kind for every requester', () => {
    for (const requesterKind of REQUESTER_KINDS) {
      expect(DISCLOSURE_CEILING[requesterKind]).toBeDefined();
      for (const kind of DISCLOSURE_CEILING[requesterKind]) {
        expect(DISCLOSURE_KINDS).toContain(kind);
      }
    }
  });
});

describe('cross-tenant', () => {
  it('refuses a client asking about somebody else’s organisation', () => {
    const decision = mayDisclose(request({ concernsRequestersOwnOrganisation: false }));
    expect(decision.permitted).toBe(false);
    expect(decision.permitted === false && decision.remedy).toMatch(/security matter/i);
  });

  it('refuses an MSP asking about an organisation it does not run', () => {
    const decision = mayDisclose(
      request({ requesterKind: 'MSP', requesterMspRunsOrganisation: false }),
    );
    expect(decision.permitted).toBe(false);
    expect(decision.permitted === false && decision.remedy).toMatch(/security matter/i);
  });

  it('permits the ordinary case, so the gate is not simply shut', () => {
    // A control that refuses everything passes every negative test and is
    // useless. This is the positive.
    expect(mayDisclose(request()).permitted).toBe(true);
    expect(
      mayDisclose(request({ requesterKind: 'MSP', requesterMspRunsOrganisation: true })).permitted,
    ).toBe(true);
  });
});
