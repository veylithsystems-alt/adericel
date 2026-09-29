import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DISCLOSURE_CEILING,
  DISCLOSURE_KINDS,
  SUPPORT_CASE_STATES,
  SUPPORT_CATEGORIES,
  mayAssign,
  mayDisclose,
  routeCase,
  type DisclosureKind,
  type RequesterKind,
} from '@adericel/support';
import { PERMISSION_CLASS, SURFACE_DEFINITIONS } from '@adericel/domain';

const ROOT = new URL('../..', import.meta.url).pathname;

function code(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Support is a new disclosure surface, and it obeys the old boundaries.
 *
 * Contract v3.1 §22. The three surfaces (ADR-0031) were built so that a
 * Veylith administrator has no standing access to a customer's assurance data.
 * Support is where that erodes, because the agent is trying to help and the
 * data would help — so these tests check that the support model agrees with the
 * surface model rather than quietly widening it.
 */
describe('support does not widen the surface boundaries', () => {
  it('never lets Veylith see what the Veylith surface refuses', () => {
    /**
     * `VEYLITH_INTERNAL` reads COMPANY_OPERATIONS and PLATFORM_ADMINISTRATION
     * and nothing else. If support let a Veylith agent see a customer's
     * assurance state, it would have re-opened by helpdesk exactly what the
     * surface model closed structurally.
     */
    const tenantClasses = ['TENANT_ASSURANCE', 'TENANT_ADMINISTRATION'];
    expect(SURFACE_DEFINITIONS.VEYLITH_INTERNAL.reads).not.toContain(tenantClasses[0]);
    expect(SURFACE_DEFINITIONS.VEYLITH_INTERNAL.reads).not.toContain(tenantClasses[1]);

    for (const kind of ['ASSURANCE_STATE', 'ESTATE_DETAIL', 'EVIDENCE', 'PERSONAL_DATA'] as const) {
      expect(DISCLOSURE_CEILING.VEYLITH).not.toContain(kind);
    }
  });

  it('never lets a client see what the client surface refuses', () => {
    // ADERICEL_CLIENT excludes MSP_PORTFOLIO so a client cannot learn who else
    // their MSP serves or what the MSP is charged. Support agrees.
    expect(SURFACE_DEFINITIONS.ADERICEL_CLIENT.reads).not.toContain('MSP_PORTFOLIO');
    expect(DISCLOSURE_CEILING.END_CUSTOMER).not.toContain('COMMERCIAL_POSITION');
    expect(PERMISSION_CLASS['msp:billing:read']).toBe('MSP_PORTFOLIO');
  });

  it('classifies every disclosure kind for every requester', () => {
    // Exhaustive by construction. A kind nobody classified is a kind whose
    // boundary nobody decided, and the default must never be "allowed".
    for (const requesterKind of Object.keys(DISCLOSURE_CEILING) as RequesterKind[]) {
      for (const kind of DISCLOSURE_CEILING[requesterKind]) {
        expect(DISCLOSURE_KINDS).toContain(kind);
      }
    }
  });
});

describe('nothing is said before somebody is identified', () => {
  it('refuses every kind, in every pre-triage state, for every requester', () => {
    /**
     * The exhaustive version of §22, over the whole cross product rather than
     * the one case anybody would think to check.
     *
     * The failure this prevents is a stranger who sounds plausible being told
     * which controls an organisation is failing. Row-level security does not
     * prevent it, because the person disclosing is authorised.
     */
    const preTriage = ['RECEIVED', 'IDENTITY_PENDING', 'ENTITLEMENT_PENDING'] as const;
    for (const caseState of preTriage) {
      for (const requesterKind of Object.keys(DISCLOSURE_CEILING) as RequesterKind[]) {
        for (const kind of DISCLOSURE_KINDS as readonly DisclosureKind[]) {
          const decision = mayDisclose({
            kind,
            caseState,
            requesterKind,
            identifiedBy: 'AUTHENTICATED_SESSION',
            identifiedAtIso: '2026-09-16T12:00:00.000Z',
            atIso: '2026-09-16T12:00:01.000Z',
            concernsRequestersOwnOrganisation: true,
            requesterMspRunsOrganisation: true,
            directSupportEntitled: true,
          });
          expect(decision.permitted).toBe(false);
        }
      }
    }
  });

  it('refuses an unidentified requester in every state that otherwise permits', () => {
    for (const caseState of SUPPORT_CASE_STATES) {
      const decision = mayDisclose({
        kind: 'CASE_STATUS',
        caseState,
        requesterKind: 'END_CUSTOMER',
        identifiedBy: 'NONE',
        identifiedAtIso: null,
        atIso: '2026-09-16T12:00:00.000Z',
        concernsRequestersOwnOrganisation: true,
        requesterMspRunsOrganisation: false,
        directSupportEntitled: false,
      });
      expect(decision.permitted).toBe(false);
    }
  });
});

describe('the distribution boundary has no back door', () => {
  it('routes no end-customer case to Veylith without a signed agreement', () => {
    for (const category of SUPPORT_CATEGORIES) {
      if (category === 'SECURITY_CONCERN') continue;
      for (const severity of ['S1', 'S2', 'S3', 'S4'] as const) {
        const decision = routeCase({
          requesterKind: 'END_CUSTOMER',
          category,
          severity,
          directSupportEntitled: false,
        });
        expect(decision.queue.startsWith('MSP_')).toBe(true);
      }
    }
  });

  it('cannot be crossed by reassignment either', () => {
    // Routing decides where a case starts; reassignment is how a boundary is
    // usually crossed in practice — by somebody tidying a backlog toward the
    // team with the expertise.
    for (const category of SUPPORT_CATEGORIES) {
      if (category === 'SECURITY_CONCERN') continue;
      const decision = mayAssign('VEYLITH_ENGINEERING', {
        requesterKind: 'END_CUSTOMER',
        directSupportEntitled: false,
        category,
      });
      expect(decision.permitted).toBe(false);
    }
  });

  it('ships with the direct-support table empty and no code that fills it', () => {
    /**
     * Decision D2: build the gate, grant it to nobody. §22 needs the gate
     * regardless, and shipping it closed means an MSP sees a system that
     * structurally cannot talk to their customer behind their back.
     *
     * Asserted over the source: there is no INSERT into
     * `direct_support_entitlements` anywhere in the application. When the first
     * agreement is signed, adding one is a reviewed change rather than a code
     * path that was already sitting there.
     */
    const sources = [
      'apps/api/src/services/support.ts',
      'apps/api/src/routes/support.ts',
      'apps/worker/src/index.ts',
    ]
      .map(code)
      .join('\n');
    expect(sources).not.toMatch(/INSERT\s+INTO\s+direct_support_entitlements/i);
  });
});

describe('diagnostic bundles cannot be widened by accident', () => {
  it('collects named columns only, never SELECT *', () => {
    /**
     * The denylist in `buildDiagnosticBundle` is the second line of defence.
     * The first is that collectors return shaped data — and a `SELECT *` would
     * put whatever a future migration adds into a file that leaves the
     * building, under a key nobody chose.
     */
    const service = code('apps/api/src/services/support.ts');
    const collector = service.slice(service.indexOf('async function collectSections'));
    expect(collector).not.toMatch(/SELECT\s+\*/i);
  });

  it('does not collect a connector’s error text', () => {
    // A provider's error routinely echoes the request that failed, which is how
    // a token ends up in a field called "message". The denylist would not catch
    // it: the key is innocent and the value is not.
    const service = code('apps/api/src/services/support.ts');
    const collector = service.slice(service.indexOf('async function collectSections'));
    expect(collector).not.toMatch(/\blast_error\b/);
    expect(collector).not.toMatch(/\bsealed_credentials\b/);
    expect(collector).not.toMatch(/\bconfiguration\b/);
  });
});
