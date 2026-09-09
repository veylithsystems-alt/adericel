import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normaliseRecoveryCode,
  totpCodeForStep,
  totpProvisioningUri,
  totpStep,
  verifyTotp,
} from './totp.js';

/**
 * RFC 6238 publishes test vectors for the shared secret "12345678901234567890".
 * They are the only way to know an implementation is interoperable rather than
 * merely self-consistent: a wrong-but-consistent TOTP passes every test you
 * write about itself and no authenticator app on earth.
 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'utf8'));

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const input of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'hello world']) {
      const buffer = Buffer.from(input, 'utf8');
      expect(base32Decode(base32Encode(buffer)).toString('utf8')).toBe(input);
    }
  });

  it('matches RFC 4648 encodings', () => {
    expect(base32Encode(Buffer.from('foobar', 'utf8'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('f', 'utf8'))).toBe('MY');
  });

  it('tolerates whitespace and lower case on input, as users type it', () => {
    expect(base32Decode('mz xw 6y tb oi').toString('utf8')).toBe('foobar');
  });

  it('refuses a character outside the alphabet rather than guessing', () => {
    expect(() => base32Decode('MZXW6YTB01')).toThrow(/Invalid base32/);
  });
});

describe('TOTP against the RFC 6238 vectors', () => {
  // Published vectors: epoch second, expected SHA-1 code (first six digits of
  // the eight-digit vector, since Adericel uses six).
  const vectors: ReadonlyArray<readonly [number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];

  for (const [epochSeconds, expected] of vectors) {
    it(`produces ${expected} at ${epochSeconds}`, () => {
      const step = totpStep(epochSeconds * 1000);
      expect(totpCodeForStep(RFC_SECRET, step)).toBe(expected);
    });
  }

  it('still works past 2038, where a 32-bit time_t would have wrapped', () => {
    // The last vector is at epoch second 20,000,000,000 — comfortably beyond
    // the signed 32-bit boundary that breaks naive implementations. The step
    // itself is smaller, but the arithmetic that produces it is where the
    // overflow would happen.
    const epochSeconds = 20_000_000_000;
    expect(epochSeconds).toBeGreaterThan(2 ** 31);
    expect(totpCodeForStep(RFC_SECRET, totpStep(epochSeconds * 1000))).toBe('353130');
  });
});

describe('verifyTotp', () => {
  const NOW = 1_700_000_000_000;
  const secret = generateTotpSecret();
  const current = totpStep(NOW);

  it('accepts the current code', () => {
    const code = totpCodeForStep(secret, current);
    expect(verifyTotp(secret, code, { nowEpochMs: NOW })).toEqual({ step: current });
  });

  it('accepts one step either side, for clock drift', () => {
    expect(verifyTotp(secret, totpCodeForStep(secret, current - 1), { nowEpochMs: NOW })).toEqual({
      step: current - 1,
    });
    expect(verifyTotp(secret, totpCodeForStep(secret, current + 1), { nowEpochMs: NOW })).toEqual({
      step: current + 1,
    });
  });

  it('refuses two steps away', () => {
    expect(
      verifyTotp(secret, totpCodeForStep(secret, current - 2), { nowEpochMs: NOW }),
    ).toBeNull();
    expect(
      verifyTotp(secret, totpCodeForStep(secret, current + 2), { nowEpochMs: NOW }),
    ).toBeNull();
  });

  it('refuses a replay of a code already used, inside its own window', () => {
    const code = totpCodeForStep(secret, current);
    const first = verifyTotp(secret, code, { nowEpochMs: NOW });
    expect(first).toEqual({ step: current });

    // Same code, same 30 seconds, second presentation. Without step tracking
    // this succeeds, which is exactly how a shoulder-surfed code gets reused.
    expect(verifyTotp(secret, code, { nowEpochMs: NOW, lastUsedStep: first!.step })).toBeNull();
  });

  it('refuses an earlier step once a later one has been used', () => {
    expect(
      verifyTotp(secret, totpCodeForStep(secret, current - 1), {
        nowEpochMs: NOW,
        lastUsedStep: current,
      }),
    ).toBeNull();
  });

  it('accepts the next step after the current one has been used', () => {
    expect(
      verifyTotp(secret, totpCodeForStep(secret, current + 1), {
        nowEpochMs: NOW,
        lastUsedStep: current,
      }),
    ).toEqual({ step: current + 1 });
  });

  it('refuses anything that is not six digits without touching the secret', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78', '-12345']) {
      expect(verifyTotp(secret, bad, { nowEpochMs: NOW })).toBeNull();
    }
  });

  it('tolerates a space in the middle, which is how phones display codes', () => {
    const code = totpCodeForStep(secret, current);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(secret, spaced, { nowEpochMs: NOW })).toEqual({ step: current });
  });

  it('does not accept another secret’s code', () => {
    const other = generateTotpSecret();
    expect(verifyTotp(secret, totpCodeForStep(other, current), { nowEpochMs: NOW })).toBeNull();
  });
});

describe('provisioning URI', () => {
  it('carries everything an authenticator needs, with the issuer twice', () => {
    const uri = totpProvisioningUri({
      secretBase32: 'JBSWY3DPEHPK3PXP',
      accountName: 'owner@meridian.test',
      issuer: 'Adericel',
    });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(encodeURIComponent('Adericel:owner@meridian.test'));
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Adericel');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('recovery codes', () => {
  it('generates ten distinct grouped codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  });

  it('hashes independently of how the user typed it', () => {
    const [code] = generateRecoveryCodes(1) as [string];
    const typedBadly = ` ${code.toLowerCase().replace('-', ' ')} `;
    expect(hashRecoveryCode(typedBadly)).toBe(hashRecoveryCode(code));
    expect(normaliseRecoveryCode(typedBadly)).toBe(normaliseRecoveryCode(code));
  });

  it('does not store the code itself', () => {
    const [code] = generateRecoveryCodes(1) as [string];
    const hash = hashRecoveryCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normaliseRecoveryCode(code));
  });
});
