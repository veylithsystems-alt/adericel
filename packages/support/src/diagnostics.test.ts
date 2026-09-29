import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_SECTIONS,
  DiagnosticRefusal,
  buildDiagnosticBundle,
  verifyDiagnosticBundle,
  type DiagnosticBundleInput,
} from './diagnostics.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000002';

function input(overrides: Partial<DiagnosticBundleInput> = {}): DiagnosticBundleInput {
  return {
    organisationId: ORG,
    caseId: 'case-1',
    requestedBy: 'Support Engineer',
    requestedAtIso: '2026-09-16T12:00:00.000Z',
    sections: ['INTEGRATION_HEALTH'],
    content: {
      INTEGRATION_HEALTH: [
        { connector: 'microsoft-entra', healthy: false, lastSuccessAt: '2026-09-14T03:00:00.000Z' },
      ],
    },
    ...overrides,
  };
}

describe('a bundle carries what fixes it, and nothing else', () => {
  it('refuses a credential, wherever it is hiding', () => {
    /**
     * This is the artefact most likely to leak, because it is broad by design,
     * it leaves the platform, and it is assembled at speed by somebody under
     * pressure.
     *
     * It refuses rather than redacts: a bundle that silently dropped a field
     * would read as complete, and what an engineer concludes from an absence
     * is not what is true.
     */
    const shapes = [
      { INTEGRATION_HEALTH: { clientSecret: 'shhh' } },
      { INTEGRATION_HEALTH: [{ nested: { refresh_token: 'shhh' } }] },
      { INTEGRATION_HEALTH: [{ list: [{ deep: { apiKey: 'shhh' } }] }] },
      { INTEGRATION_HEALTH: { Authorization: 'Bearer x' } },
      { INTEGRATION_HEALTH: { credentialCiphertext: 'x' } },
    ];
    for (const content of shapes) {
      expect(() => buildDiagnosticBundle(input({ content }))).toThrow(DiagnosticRefusal);
    }
  });

  it('refuses personal data just as firmly', () => {
    // A diagnostic bundle explaining why a connector failed does not need to
    // say whose mailbox it was. The commonest way personal data leaves a
    // platform is inside something gathered for another purpose.
    for (const content of [
      { INTEGRATION_HEALTH: [{ userEmail: 'someone@example.test' }] },
      { INTEGRATION_HEALTH: [{ owner: { displayName: 'A Person' } }] },
      { INTEGRATION_HEALTH: [{ contact: { phoneNumber: '07000 000000' } }] },
    ]) {
      expect(() => buildDiagnosticBundle(input({ content }))).toThrow(DiagnosticRefusal);
    }
  });

  it('names the path it refused, so the collector gets fixed', () => {
    try {
      buildDiagnosticBundle(input({ content: { INTEGRATION_HEALTH: [{ a: { token: 'x' } }] } }));
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(DiagnosticRefusal);
      expect((error as DiagnosticRefusal).path).toBe('$.content.INTEGRATION_HEALTH[0].a.token');
      expect((error as DiagnosticRefusal).message).toMatch(/Fix the collector/i);
    }
  });

  it('refuses a section that was not asked for', () => {
    // What a bundle contains and what it says it contains must be the same
    // thing, or the declaration is decoration.
    expect(() =>
      buildDiagnosticBundle(
        input({
          sections: ['INTEGRATION_HEALTH'],
          content: { INTEGRATION_HEALTH: [], ASSESSMENT_TRACE: [] },
        }),
      ),
    ).toThrow(/did not ask for it/i);
  });

  it('refuses a section nobody defined', () => {
    expect(() => buildDiagnosticBundle(input({ content: { RAW_DATABASE_DUMP: [] } }))).toThrow(
      /not a diagnostic section/i,
    );
  });

  it('refuses an empty bundle', () => {
    expect(() => buildDiagnosticBundle(input({ sections: [], content: {} }))).toThrow(
      /not a bundle/i,
    );
  });

  it('builds the ordinary case, so the control is not simply shut', () => {
    const bundle = buildDiagnosticBundle(input());
    expect(bundle.contentHash).toMatch(/^sha256:/);
    expect(bundle.scope).toContain(ORG);
    expect(bundle.organisationId).toBe(ORG);
  });

  it('defines every section it advertises', () => {
    expect(new Set(DIAGNOSTIC_SECTIONS).size).toBe(DIAGNOSTIC_SECTIONS.length);
  });
});

describe('a bundle says whose it is, and proves it has not changed', () => {
  it('verifies an untouched bundle', () => {
    const bundle = buildDiagnosticBundle(input());
    expect(verifyDiagnosticBundle(bundle, ORG).intact).toBe(true);
  });

  it('refuses a bundle for another tenant, even when it is intact', () => {
    // Both halves matter. An intact bundle naming another tenant is an intact
    // cross-tenant disclosure.
    const bundle = buildDiagnosticBundle(input());
    const verdict = verifyDiagnosticBundle(bundle, OTHER_ORG);
    expect(verdict.intact).toBe(false);
    expect(verdict.reason).toMatch(/cross-tenant/i);
  });

  it('detects a bundle edited after it was produced', () => {
    /**
     * A support artefact that can be altered on its way to an engineer is a way
     * to make them chase a fault that does not exist — or to stop them seeing
     * the one that does.
     */
    const bundle = buildDiagnosticBundle(input());
    const tampered = {
      ...bundle,
      content: { INTEGRATION_HEALTH: [{ connector: 'microsoft-entra', healthy: true }] },
    };
    const verdict = verifyDiagnosticBundle(tampered, ORG);
    expect(verdict.intact).toBe(false);
    expect(verdict.reason).toMatch(/changed since it was produced/i);
  });

  it('detects a swapped case id or requester', () => {
    // Everything that gives the bundle its meaning is inside the hash, not
    // only the payload: who asked and which case it belongs to are part of
    // what an engineer relies on.
    const bundle = buildDiagnosticBundle(input());
    expect(verifyDiagnosticBundle({ ...bundle, caseId: 'case-2' }, ORG).intact).toBe(false);
    expect(verifyDiagnosticBundle({ ...bundle, requestedBy: 'Someone else' }, ORG).intact).toBe(
      false,
    );
  });

  it('hashes the same content the same way regardless of key order', () => {
    // Canonical form, so a bundle serialised by a different runtime still
    // verifies. Otherwise "changed in transit" would fire on nothing changing.
    const a = buildDiagnosticBundle(
      input({
        sections: ['INTEGRATION_HEALTH', 'PLATFORM_VERSIONS'],
        content: { INTEGRATION_HEALTH: [{ x: 1, y: 2 }], PLATFORM_VERSIONS: { engine: '1' } },
      }),
    );
    const b = buildDiagnosticBundle(
      input({
        sections: ['PLATFORM_VERSIONS', 'INTEGRATION_HEALTH'],
        content: { PLATFORM_VERSIONS: { engine: '1' }, INTEGRATION_HEALTH: [{ y: 2, x: 1 }] },
      }),
    );
    expect(a.contentHash).toBe(b.contentHash);
  });
});
