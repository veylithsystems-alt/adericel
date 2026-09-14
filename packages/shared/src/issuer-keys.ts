import { z } from 'zod';
import { publicKeyFromPem, type IssuerPublicKey } from './signing.js';

/**
 * The issuer-key lifecycle and its configuration contract.
 *
 *   GENERATE -> REGISTER -> ACTIVATE -> SIGN -> ROTATE -> RETIRE
 *
 * Adericel does not run a heavyweight PKI, and the product does not need one.
 * What it needs is a clean, honest contract:
 *
 *   - Exactly one ACTIVE key signs at any time.
 *   - RETIRED keys are retained for verification, never destroyed, because
 *     destroying a key destroys the ability to verify every passport it ever
 *     signed — the opposite of what an assurance record is for.
 *   - keyIds are immutable and unique.
 *   - Signing keys are configured separately from ordinary application secrets
 *     and are never derived from the deployment root secret, so signing
 *     authority can be custodied differently (an HSM or KMS later) without
 *     touching passport semantics or any other secret.
 *
 * This module models the *public* side and the config shape. Private key
 * material is handled only by `createIssuerSigner` from a value the deployment
 * supplies, and never appears in a record, an export, a log or a test fixture.
 */

export const ISSUER_KEY_STATUSES = ['ACTIVE', 'RETIRED'] as const;
export type IssuerKeyStatus = (typeof ISSUER_KEY_STATUSES)[number];

/**
 * One configured verification key. The private half for the ACTIVE key is
 * supplied separately (SIGNING private material is not part of this public
 * descriptor), so this whole structure is safe to publish.
 */
export const issuerKeyDescriptorSchema = z.object({
  keyId: z.string().min(1).max(200),
  status: z.enum(ISSUER_KEY_STATUSES),
  algorithm: z.literal('Ed25519'),
  /** SPKI PEM. Public only. */
  publicKeyPem: z.string().min(1),
  /** When this key became active. Informational for verifiers and audits. */
  activatedAt: z.string().min(1),
  /** Set once retired; retained so historical records keep verifying. */
  retiredAt: z.string().nullable().default(null),
});
export type IssuerKeyDescriptor = z.infer<typeof issuerKeyDescriptorSchema>;

export const issuerKeyRingSchema = z
  .object({
    issuerName: z.string().min(1).max(200).default('Adericel'),
    keys: z.array(issuerKeyDescriptorSchema).default([]),
  })
  .superRefine((ring, ctx) => {
    const ids = new Set<string>();
    for (const key of ring.keys) {
      if (ids.has(key.keyId)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate issuer keyId ${key.keyId}` });
      }
      ids.add(key.keyId);
    }
    const active = ring.keys.filter((k) => k.status === 'ACTIVE');
    if (active.length > 1) {
      ctx.addIssue({
        code: 'custom',
        message: `Exactly one issuer key may be ACTIVE; found ${active.length}`,
      });
    }
  });
export type IssuerKeyRing = z.infer<typeof issuerKeyRingSchema>;

/** The public keys a verifier trusts, in the portable form. Includes retired
 * keys, so historical passports keep verifying. */
export function publishableKeys(ring: IssuerKeyRing): IssuerPublicKey[] {
  return ring.keys.map((k) => publicKeyFromPem(k.publicKeyPem, k.keyId));
}

/** The single active key's id, or null if none is configured. */
export function activeKeyId(ring: IssuerKeyRing): string | null {
  return ring.keys.find((k) => k.status === 'ACTIVE')?.keyId ?? null;
}
