import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238), implemented directly.
 *
 * The same reasoning as the JWT verifier in the API: this is an authentication
 * boundary, and it is short enough that every branch should be visible and
 * unit-tested rather than depending on a library's option defaults. TOTP is
 * eighty lines of HMAC and arithmetic; the risk in a dependency here is larger
 * than the risk in the code.
 *
 * Choices worth stating:
 *
 *  - SHA-1, six digits, thirty-second period. These are not the strongest
 *    available parameters; they are the ones every authenticator application
 *    actually implements. A configuration nobody's phone can enrol in is not
 *    security, it is an outage.
 *  - Verification returns the matched **time step**, not a boolean. The caller
 *    stores it and refuses any step less than or equal to the last one used,
 *    which is what stops a code observed over someone's shoulder — or captured
 *    in a proxy log — from being replayed inside its own validity window.
 *  - Comparison is constant time, over the formatted digits.
 */

const PERIOD_SECONDS = 30;
const DIGITS = 6;

/**
 * How many steps either side of the current one are accepted.
 *
 * One step is ±30 seconds, which covers ordinary phone clock drift and a user
 * who starts typing as the code is about to roll. Widening this multiplies the
 * number of codes valid at any moment, so it stays at one.
 */
const DEFAULT_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, unpadded — the encoding every authenticator app expects. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(encoded: string): Buffer {
  // The padding is stripped with a loop rather than `/=+$/`: anchored repetition
  // is polynomial under backtracking, and this takes attacker-supplied text —
  // a TOTP secret arriving from configuration or an enrolment payload.
  let end = encoded.length;
  while (end > 0 && encoded[end - 1] === '=') end -= 1;
  const normalised = encoded.slice(0, end).replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of normalised) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character in TOTP secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/**
 * A fresh shared secret.
 *
 * Twenty bytes is RFC 4226's recommendation and matches the HMAC-SHA1 block
 * output, so there is nothing to gain from a longer one.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The time step a given instant falls in. */
export function totpStep(epochMs: number, periodSeconds = PERIOD_SECONDS): number {
  return Math.floor(epochMs / 1000 / periodSeconds);
}

/** The code for one specific step. Exported so tests can pin a step exactly. */
export function totpCodeForStep(secretBase32: string, step: number, digits = DIGITS): string {
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  // The counter is a 64-bit big-endian integer. Node's writeBigUInt64BE keeps
  // this correct past 2038 without the manual splitting most implementations do.
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.4: the low nibble of the final byte picks
  // the offset, so which four bytes are used varies with the digest itself.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export interface TotpVerification {
  /** The step the presented code matched, for replay prevention. */
  readonly step: number;
}

export interface TotpVerifyOptions {
  readonly nowEpochMs: number;
  readonly window?: number;
  /**
   * The highest step already consumed by this factor. A code at or below it is
   * refused even when it is otherwise valid — that is the whole point.
   */
  readonly lastUsedStep?: number | null;
}

/**
 * Verify a presented code.
 *
 * Returns the matched step, or null. Every candidate step is compared even
 * after a match so that verification takes the same time regardless of which
 * step matched, or whether any did.
 */
export function verifyTotp(
  secretBase32: string,
  presented: string,
  options: TotpVerifyOptions,
): TotpVerification | null {
  const digits = presented.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(digits)) return null;

  const window = options.window ?? DEFAULT_WINDOW;
  const current = totpStep(options.nowEpochMs);
  const presentedBuffer = Buffer.from(digits, 'utf8');

  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    const candidate = Buffer.from(totpCodeForStep(secretBase32, step), 'utf8');
    // Lengths are equal by construction, so timingSafeEqual is safe to call
    // directly and is evaluated for every step rather than short-circuiting.
    if (timingSafeEqual(candidate, presentedBuffer) && matched === null) {
      matched = step;
    }
  }

  if (matched === null) return null;
  if (options.lastUsedStep !== undefined && options.lastUsedStep !== null) {
    if (matched <= options.lastUsedStep) return null;
  }
  return { step: matched };
}

/**
 * The `otpauth://` URI an authenticator application enrols from, usually by
 * scanning it as a QR code.
 *
 * The issuer appears twice — once as a label prefix and once as a parameter —
 * because different applications read different ones, and an enrolment that
 * shows up in someone's app as an unlabelled six-digit code is one they will
 * delete the next time they tidy up.
 */
export function totpProvisioningUri(options: {
  readonly secretBase32: string;
  readonly accountName: string;
  readonly issuer: string;
}): string {
  const label = `${options.issuer}:${options.accountName}`;
  const params = new URLSearchParams({
    secret: options.secretBase32,
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/**
 * Recovery codes.
 *
 * The failure mode this exists for is a lost or wiped phone, and the person it
 * happens to is locked out of a security product in the middle of an incident.
 * Ten single-use codes, shown exactly once, hashed at rest like any other
 * credential.
 *
 * Grouped with a hyphen because they get written down, and an unbroken run of
 * ten characters gets written down wrong.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // Fifteen base32 characters is 75 bits. The previous ten characters was 50,
    // which is inside reach of an offline attack once the digest is known —
    // and the digest used to be reproducible by anyone, because it was not
    // keyed. Both halves of that are now fixed; this is the half that survives
    // even if the hashing key is disclosed too.
    const raw = base32Encode(randomBytes(10)).slice(0, 15);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}`);
  }
  return codes;
}

/** Normalised so that case and the grouping hyphen do not matter on entry. */
export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Recovery codes are hashed with a key derived from the deployment secret —
 * `TokenHasher` in crypto.ts — rather than here, so that a database disclosure
 * alone does not permit an offline search. Normalisation happens first so that
 * how somebody typed the code cannot change its digest.
 */
export function recoveryCodeDigestInput(code: string): string {
  return normaliseRecoveryCode(code);
}
