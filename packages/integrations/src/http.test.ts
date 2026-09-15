import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nullLogger } from '@adericel/shared';
import {
  assertEgressAllowed,
  createGuardedLookup,
  createHttpClient,
  hostAllowed,
  isPrivateAddress,
  PERMISSIVE_EGRESS,
} from './http.js';

/**
 * Connector egress.
 *
 * Server-side request forgery is the dominant risk in this component: a
 * customer configures an endpoint and Adericel's server fetches it, from inside
 * whatever network Adericel is deployed in. These tests attack that.
 */

describe('isPrivateAddress', () => {
  const privateAddresses = [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // the cloud metadata service, the canonical target
    '100.64.0.1', // carrier-grade NAT
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:169.254.169.254', // v4-mapped, which bypasses a naive v4-only check
  ];

  const publicAddresses = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111'];

  for (const address of privateAddresses) {
    it(`refuses ${address}`, () => expect(isPrivateAddress(address)).toBe(true));
  }
  for (const address of publicAddresses) {
    it(`permits ${address}`, () => expect(isPrivateAddress(address)).toBe(false));
  }
});

describe('hostAllowed', () => {
  it('permits anything when the allowlist is empty', () => {
    expect(hostAllowed('graph.microsoft.com', [])).toBe(true);
  });

  it('matches an exact host and a suffix pattern', () => {
    expect(hostAllowed('graph.microsoft.com', ['graph.microsoft.com'])).toBe(true);
    expect(hostAllowed('graph.microsoft.com', ['.microsoft.com'])).toBe(true);
    expect(hostAllowed('GRAPH.MICROSOFT.COM', ['.microsoft.com'])).toBe(true);
  });

  it('does not treat a suffix as a substring', () => {
    // The attack this prevents: registering evil-microsoft.com and having it
    // match an allowlist entry of "microsoft.com".
    expect(hostAllowed('evil-microsoft.com', ['.microsoft.com'])).toBe(false);
    expect(hostAllowed('microsoft.com.attacker.net', ['.microsoft.com'])).toBe(false);
  });
});

describe('assertEgressAllowed', () => {
  const strict = { allowlist: [], blockPrivate: true };
  const resolvesTo = (address: string) => async () => [address];

  it('refuses a scheme that is not http or https', async () => {
    await expect(assertEgressAllowed('file:///etc/passwd', strict)).rejects.toThrow(
      /Unsupported URL scheme/,
    );
    await expect(assertEgressAllowed('gopher://example.com/', strict)).rejects.toThrow(
      /Unsupported URL scheme/,
    );
  });

  it('refuses plaintext HTTP when private egress is blocked', async () => {
    await expect(
      assertEgressAllowed('http://example.com/', strict, resolvesTo('8.8.8.8')),
    ).rejects.toThrow(/Plaintext HTTP/);
  });

  it('refuses a host that resolves into a private range', async () => {
    await expect(
      assertEgressAllowed('https://metadata.attacker.test/', strict, resolvesTo('169.254.169.254')),
    ).rejects.toThrow(/non-public address/);
  });

  it('refuses a literal private address without needing DNS', async () => {
    await expect(assertEgressAllowed('https://127.0.0.1/', strict)).rejects.toThrow(
      /non-public address/,
    );
  });

  it('refuses a host outside the allowlist before it resolves anything', async () => {
    let resolverCalled = false;
    await expect(
      assertEgressAllowed(
        'https://elsewhere.test/',
        { allowlist: ['.microsoft.com'], blockPrivate: true },
        async () => {
          resolverCalled = true;
          return ['8.8.8.8'];
        },
      ),
    ).rejects.toThrow(/allowlist/);
    expect(resolverCalled).toBe(false);
  });

  it('permits a public host', async () => {
    await expect(
      assertEgressAllowed(
        'https://graph.microsoft.com/v1.0/users',
        strict,
        resolvesTo('20.190.1.1'),
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a host that resolves to a mix of public and private addresses', async () => {
    // A rebinding attempt with extra steps: the socket may pick either, so
    // neither is acceptable.
    await expect(
      assertEgressAllowed('https://mixed.test/', strict, async () => ['8.8.8.8', '10.0.0.1']),
    ).rejects.toThrow(/non-public address/);
  });
});

describe('the client actually connecting', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ reached: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reaches a loopback server when the policy permits private egress', async () => {
    // Development and the test harness run this way. If this fails, the tests
    // below prove nothing, because they would pass with a broken server too.
    const client = createHttpClient({ policy: PERMISSIVE_EGRESS, logger: nullLogger });
    const body = await client.json<{ reached: boolean }>({
      url: `http://127.0.0.1:${port}/`,
    });
    expect(body.reached).toBe(true);
  });

  it('refuses the same server when the policy blocks private egress', async () => {
    const client = createHttpClient({
      policy: { allowlist: [], blockPrivate: true },
      logger: nullLogger,
      retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false },
    });
    await expect(client.json({ url: `http://127.0.0.1:${port}/` })).rejects.toThrow();
  });

  it('refuses a hostname that resolves to loopback, even with the pre-flight check subverted', async () => {
    // The pre-flight resolver is told to lie in the attacker's favour, claiming
    // a public address for a name that points inside. That is exactly the state
    // DNS rebinding produces: the first resolution looked fine and the second
    // one does not. Only the connect-time guard is left standing.
    const client = createHttpClient({
      policy: { allowlist: [], blockPrivate: true },
      logger: nullLogger,
      resolver: async () => ['8.8.8.8'],
      retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false },
    });

    await expect(client.json({ url: `https://localhost:${port}/` })).rejects.toThrow();
  });
});

describe('the connect-time guard itself', () => {
  // Tested directly, because the integration test above could pass for the
  // wrong reason — a TLS handshake against a plain HTTP server fails whether or
  // not the guard exists. This asserts the control, not a side effect of it.
  const resolve = (hostname: string, options: { all?: boolean }) =>
    new Promise<{ error: NodeJS.ErrnoException | null; result: unknown }>((done) => {
      createGuardedLookup()(hostname, options, (error, result) => done({ error, result }));
    });

  it('refuses localhost', async () => {
    const { error, result } = await resolve('localhost', { all: true });
    expect(error).not.toBeNull();
    expect(error?.code).toBe('EADERICELBLOCKED');
    expect(error?.message).toMatch(/non-public address/);
    expect(result).toBe('');
  });

  it('refuses localhost when the caller asks for a single address', async () => {
    // net calls lookup with all:false in some configurations. Both shapes have
    // to be guarded, or the control depends on how the socket was constructed.
    const { error } = await resolve('localhost', { all: false });
    expect(error?.code).toBe('EADERICELBLOCKED');
  });

  it('passes a resolution failure through unchanged', async () => {
    const { error } = await resolve('nonexistent.invalid', { all: true });
    expect(error).not.toBeNull();
    expect(error?.code).not.toBe('EADERICELBLOCKED');
  });
});
