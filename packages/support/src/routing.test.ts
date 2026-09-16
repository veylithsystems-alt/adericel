import { describe, expect, it } from 'vitest';
import { SUPPORT_CATEGORIES, SUPPORT_QUEUES, isMspQueue } from './case.js';
import { REQUESTER_KINDS, mayAssign, routeCase, type RequesterKind } from './routing.js';

const base = {
  severity: 'S3' as const,
  directSupportEntitled: false,
};

describe('the §2 boundary, expressed in support', () => {
  it('sends every end-customer request to their MSP', () => {
    /**
     * §20. Adericel is sold to MSPs. Veylith answering an MSP's customer
     * directly is channel conflict wearing a helpdesk.
     *
     * Asserted over all fourteen categories rather than the one anybody would
     * think to check, because the boundary is only worth anything if it has no
     * exceptions somebody found convenient.
     */
    for (const category of SUPPORT_CATEGORIES) {
      if (category === 'SECURITY_CONCERN') continue;
      const decision = routeCase({ ...base, requesterKind: 'END_CUSTOMER', category });
      expect(isMspQueue(decision.queue)).toBe(true);
    }
  });

  it('reaches Veylith only on a signed agreement', () => {
    const without = routeCase({ ...base, requesterKind: 'END_CUSTOMER', category: 'ONBOARDING' });
    expect(isMspQueue(without.queue)).toBe(true);

    const with_ = routeCase({
      ...base,
      requesterKind: 'END_CUSTOMER',
      category: 'ONBOARDING',
      directSupportEntitled: true,
    });
    expect(isMspQueue(with_.queue)).toBe(false);
    expect(with_.because).toMatch(/signed agreement/i);
  });

  it('will not let a backlog tidy-up move a case across the boundary', () => {
    /**
     * Routing decides where a case starts. Reassignment is the path a boundary
     * is usually crossed by: somebody triaging a queue drags a case into a
     * Veylith queue because that is where the expertise is, and the MSP finds
     * out that their supplier has been talking to their customer.
     */
    for (const queue of SUPPORT_QUEUES) {
      if (isMspQueue(queue) || queue === 'EXTERNAL_DEPENDENCY') continue;
      const decision = mayAssign(queue, {
        requesterKind: 'END_CUSTOMER',
        directSupportEntitled: false,
        category: 'INTEGRATION_FAILURE',
      });
      expect(decision.permitted).toBe(false);
      expect(decision.reason).toMatch(/through the MSP/i);
    }
  });

  it('tells the requester why, in words that are true', () => {
    const decision = routeCase({
      ...base,
      requesterKind: 'END_CUSTOMER',
      category: 'ASSURANCE_EXPLANATION',
    });
    expect(decision.because).toMatch(/delivered through your MSP/i);
  });
});

describe('security is the one exception, and it is deliberate', () => {
  it('goes to Veylith security whoever raised it', () => {
    for (const requesterKind of REQUESTER_KINDS) {
      const decision = routeCase({ ...base, requesterKind, category: 'SECURITY_CONCERN' });
      expect(decision.queue).toBe('VEYLITH_SECURITY');
    }
  });

  it('does not thereby disclose the estate', () => {
    // Reporting a security concern is not a route into a customer's data. An
    // MSP or Veylith reporter learns nothing about the tenant from the case;
    // reaching the estate still needs break-glass, which is announced and
    // reviewed.
    for (const requesterKind of ['MSP', 'VEYLITH', 'SYSTEM'] as RequesterKind[]) {
      const decision = routeCase({ ...base, requesterKind, category: 'SECURITY_CONCERN' });
      expect(decision.disclosureScope).toBe('NONE');
    }
  });
});

describe('proactive support', () => {
  it('tells the MSP about their own customer, not Veylith', () => {
    /**
     * §24. Connector health raises its own cases. They go to the MSP: they own
     * the relationship, they usually own the credential that broke, and they
     * will be awake. A supplier finding out about their customer's problem
     * from their supplier is a relationship they do not keep.
     */
    for (const category of SUPPORT_CATEGORIES) {
      if (category === 'SECURITY_CONCERN') continue;
      const decision = routeCase({ ...base, requesterKind: 'SYSTEM', category });
      expect(isMspQueue(decision.queue)).toBe(true);
    }
  });
});

describe('specialist routing', () => {
  it('sends privacy and commercial to their own queues when Veylith handles them', () => {
    // §26. Each carries a different obligation — a statutory deadline, a
    // contract — and each is the kind of thing a frontline queue resolves by
    // accident and badly.
    expect(routeCase({ ...base, requesterKind: 'MSP', category: 'PRIVACY_REQUEST' }).queue).toBe(
      'VEYLITH_PRIVACY',
    );
    expect(routeCase({ ...base, requesterKind: 'MSP', category: 'COMMERCIAL_QUERY' }).queue).toBe(
      'VEYLITH_COMMERCIAL',
    );
  });

  it('routes every category somewhere, for every requester', () => {
    // Totality. An unrouted case is a case nobody owns.
    for (const requesterKind of REQUESTER_KINDS) {
      for (const category of SUPPORT_CATEGORIES) {
        const decision = routeCase({ ...base, requesterKind, category });
        expect(SUPPORT_QUEUES).toContain(decision.queue);
        expect(decision.because.length).toBeGreaterThan(20);
      }
    }
  });
});
