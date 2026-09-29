import { contentHash } from '@adericel/shared';

/**
 * Diagnostic bundles: enough to fix it, and nothing else.
 *
 * Contract v3.1 §23. A diagnostic bundle is the single most dangerous artefact
 * a support system produces. It is broad by construction — that is what makes
 * it useful — it leaves the platform, and it is usually assembled at speed by
 * somebody under pressure.
 *
 * Three properties follow:
 *
 *   1. **Tenant-scoped.** One organisation per bundle, named in the bundle and
 *      checked when it is assembled. A bundle spanning two tenants is not a
 *      convenience, it is a cross-tenant disclosure with a filename.
 *
 *   2. **Integrity-protected.** Content-hashed, so a bundle that has been
 *      edited between production and reading is detectable. A support artefact
 *      that can be altered on its way to an engineer is a way to make them
 *      chase a fault that does not exist.
 *
 *   3. **Redacted by construction, not by review.** Secrets and personal data
 *      are excluded by what the collector is allowed to gather, not removed
 *      afterwards by somebody reading it. Review catches what a reviewer
 *      notices, at 3am, under pressure, in a file they did not write.
 */

/** What a bundle may contain. Each entry names what it gives away. */
export const DIAGNOSTIC_SECTIONS = [
  /** Connector identity, health, last success, error class. No credentials. */
  'INTEGRATION_HEALTH',
  /** Which observations arrived, when, and how many. Counts, not contents. */
  'COLLECTION_TIMELINE',
  /** Assessment inputs and outcomes: the reason a control reads what it reads. */
  'ASSESSMENT_TRACE',
  /** Evidence metadata: source, times, hashes. Never the evidence payload. */
  'EVIDENCE_INDEX',
  /** Failed and rolled-back actions with their policy decisions. */
  'ACTION_HISTORY',
  /** Which predicates are impaired and why. */
  'IMPAIRMENT_STATE',
  /** Platform version, ruleset versions, migration level. No configuration. */
  'PLATFORM_VERSIONS',
] as const;
export type DiagnosticSection = (typeof DIAGNOSTIC_SECTIONS)[number];

/**
 * Field-name fragments a bundle may never carry, whatever section asked for it.
 *
 * A denylist is the weaker construction and is deliberately the second line
 * here: the first is that collectors return shaped data rather than rows. This
 * exists because "shaped data" is a discipline and disciplines slip, and the
 * cost of a slip is a credential in a file that left the building.
 */
const FORBIDDEN_FIELD_FRAGMENTS = [
  'secret',
  'password',
  'passphrase',
  'token',
  'credential',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'ciphertext',
  'authorization',
  'cookie',
  'sessionid',
  'session_id',
  'refresh',
  'signature',
  'email',
  'phone',
  'fullname',
  'full_name',
  'displayname',
  'display_name',
  'givenname',
  'given_name',
  'surname',
  'address',
  'postcode',
  'dateofbirth',
  'date_of_birth',
];

export interface DiagnosticBundleInput {
  readonly organisationId: string;
  readonly caseId: string;
  readonly requestedBy: string;
  readonly requestedAtIso: string;
  readonly sections: readonly DiagnosticSection[];
  /** Section name -> the shaped content a collector produced. */
  readonly content: Readonly<Record<string, unknown>>;
}

export interface DiagnosticBundle {
  readonly organisationId: string;
  readonly caseId: string;
  readonly requestedBy: string;
  readonly requestedAtIso: string;
  readonly sections: readonly DiagnosticSection[];
  readonly content: Readonly<Record<string, unknown>>;
  /** `sha256:` over the canonical form. What a reader checks. */
  readonly contentHash: string;
  /** Said inside the bundle, so it travels with it. */
  readonly scope: string;
}

export class DiagnosticRefusal extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'DiagnosticRefusal';
  }
}

/**
 * Walk the content and refuse anything that must never leave.
 *
 * Refuses rather than redacts. A bundle that silently dropped a field would be
 * a bundle an engineer reads as complete, and the thing they conclude from an
 * absence is not the thing that is true. A refusal names the path, so the
 * collector that produced it gets fixed.
 */
function assertNothingForbidden(value: unknown, path: string): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNothingForbidden(item, `${path}[${index}]`));
    return;
  }

  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalised = key.toLowerCase().replace(/[^a-z_]/g, '');
      const hit = FORBIDDEN_FIELD_FRAGMENTS.find((fragment) => normalised.includes(fragment));
      if (hit) {
        throw new DiagnosticRefusal(
          `A diagnostic bundle cannot carry "${key}" (matched "${hit}"). Fix the collector so ` +
            'it does not gather this, rather than removing it here — a bundle is assembled at ' +
            'speed by somebody under pressure, and review catches what a reviewer notices.',
          `${path}.${key}`,
        );
      }
      assertNothingForbidden(item, `${path}.${key}`);
    }
  }
}

export function buildDiagnosticBundle(input: DiagnosticBundleInput): DiagnosticBundle {
  if (input.sections.length === 0) {
    throw new DiagnosticRefusal('A bundle with no sections is not a bundle.', '$.sections');
  }

  for (const section of Object.keys(input.content)) {
    if (!DIAGNOSTIC_SECTIONS.includes(section as DiagnosticSection)) {
      throw new DiagnosticRefusal(
        `"${section}" is not a diagnostic section. The set is fixed so that adding a new kind ` +
          'of disclosure is a reviewed change rather than a key nobody noticed.',
        `$.content.${section}`,
      );
    }
    if (!input.sections.includes(section as DiagnosticSection)) {
      throw new DiagnosticRefusal(
        `The bundle carries "${section}" but did not ask for it. What a bundle contains and ` +
          'what it says it contains must be the same thing.',
        `$.content.${section}`,
      );
    }
  }

  assertNothingForbidden(input.content, '$.content');

  const body = {
    organisationId: input.organisationId,
    caseId: input.caseId,
    requestedBy: input.requestedBy,
    requestedAtIso: input.requestedAtIso,
    sections: [...input.sections].sort(),
    content: input.content,
  };

  return {
    ...body,
    sections: [...input.sections].sort(),
    contentHash: contentHash(body),
    scope:
      `This bundle concerns organisation ${input.organisationId} and no other. It carries no ` +
      'credentials and no personal data by construction. Check the content hash before acting ' +
      'on anything in it.',
  };
}

/**
 * Whether a bundle is intact and concerns the organisation it claims to.
 *
 * Both halves matter. A bundle whose hash checks out but names another tenant
 * is an intact cross-tenant disclosure.
 */
export function verifyDiagnosticBundle(
  bundle: DiagnosticBundle,
  expectedOrganisationId: string,
): { readonly intact: boolean; readonly reason: string } {
  if (bundle.organisationId !== expectedOrganisationId) {
    return {
      intact: false,
      reason:
        `This bundle concerns organisation ${bundle.organisationId}, not ` +
        `${expectedOrganisationId}. Do not read it. Treat it as a cross-tenant disclosure.`,
    };
  }

  const recomputed = contentHash({
    organisationId: bundle.organisationId,
    caseId: bundle.caseId,
    requestedBy: bundle.requestedBy,
    requestedAtIso: bundle.requestedAtIso,
    sections: [...bundle.sections].sort(),
    content: bundle.content,
  });

  if (recomputed !== bundle.contentHash) {
    return {
      intact: false,
      reason:
        'This bundle has changed since it was produced. Do not diagnose from it — a support ' +
        'artefact that can be altered in transit is a way to make an engineer chase a fault ' +
        'that does not exist.',
    };
  }

  return { intact: true, reason: 'Intact, and concerns the organisation it claims to.' };
}
