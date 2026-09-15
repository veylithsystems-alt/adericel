import { createHmac, timingSafeEqual } from 'node:crypto';
import { AdericelError, constantTimeEquals, type TokenHasher } from '@adericel/shared';

/**
 * Access tokens.
 *
 * HS256 JWTs, implemented directly. The verification path is the security
 * boundary of the whole API, so it is written here where every branch is
 * visible and unit-tested rather than depending on a library's option defaults.
 *
 * Deliberate choices:
 *  - the algorithm is asserted at verification time, closing the `alg: none`
 *    and algorithm-confusion classes entirely;
 *  - the signature is compared in constant time;
 *  - expiry, not-before, issuer and audience are all mandatory.
 *
 * Tokens carry identity only. Authority is resolved from grants on every
 * request, so revoking a grant takes effect immediately rather than at token
 * expiry.
 */

export interface AccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly name: string;
  readonly email: string | null;
  readonly mspId: string | null;
}

interface Header {
  alg: 'HS256';
  typ: 'JWT';
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(secret: string, signingInput: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

export function issueAccessToken(
  secret: string,
  claims: Omit<AccessTokenClaims, 'iat' | 'exp'>,
  issuedAtEpochSeconds: number,
  ttlSeconds: number,
): string {
  const header: Header = { alg: 'HS256', typ: 'JWT' };
  const payload: AccessTokenClaims = {
    ...claims,
    iat: issuedAtEpochSeconds,
    exp: issuedAtEpochSeconds + ttlSeconds,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${sign(secret, signingInput)}`;
}

export interface VerifyOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly nowEpochSeconds: number;
  /** Tolerance for clock skew between issuer and verifier. */
  readonly leewaySeconds?: number;
}

export function verifyAccessToken(
  secret: string,
  token: string,
  options: VerifyOptions,
): AccessTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AdericelError('UNAUTHENTICATED', 'Malformed access token');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const expected = sign(secret, `${headerPart}.${payloadPart}`);
  if (!constantTimeEquals(Buffer.from(expected), Buffer.from(signaturePart))) {
    throw new AdericelError('UNAUTHENTICATED', 'Invalid token signature');
  }

  let header: Header;
  let payload: AccessTokenClaims;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as Header;
    payload = JSON.parse(
      Buffer.from(payloadPart, 'base64url').toString('utf8'),
    ) as AccessTokenClaims;
  } catch {
    throw new AdericelError('UNAUTHENTICATED', 'Malformed access token');
  }

  // The algorithm is asserted rather than read from the token. A token that
  // declares any other algorithm is rejected outright.
  if (header.alg !== 'HS256') {
    throw new AdericelError('UNAUTHENTICATED', 'Unsupported token algorithm');
  }

  const leeway = options.leewaySeconds ?? 30;
  if (typeof payload.exp !== 'number' || payload.exp + leeway < options.nowEpochSeconds) {
    throw new AdericelError('UNAUTHENTICATED', 'Access token has expired');
  }
  if (typeof payload.iat !== 'number' || payload.iat - leeway > options.nowEpochSeconds) {
    throw new AdericelError('UNAUTHENTICATED', 'Access token is not yet valid');
  }
  if (payload.iss !== options.issuer) {
    throw new AdericelError('UNAUTHENTICATED', 'Access token issuer mismatch');
  }
  if (payload.aud !== options.audience) {
    throw new AdericelError('UNAUTHENTICATED', 'Access token audience mismatch');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new AdericelError('UNAUTHENTICATED', 'Access token has no subject');
  }

  return payload;
}

/**
 * Refresh tokens are opaque and only their digest is stored.
 *
 * The digest is keyed from the deployment secret rather than computed with a
 * public label, so a disclosure of the sessions table does not let an attacker
 * confirm a guessed token offline. See `createTokenHasher` in crypto.ts.
 */
export function hashRefreshToken(hasher: TokenHasher, token: string): string {
  return hasher.hash('refresh-token', token);
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
