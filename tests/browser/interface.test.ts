import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';
import { STATE_PRESENTATION } from '../../apps/web/src/lib/assurance-presentation.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  databaseAvailable,
  seedTenant,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * Somebody looking at it.
 *
 * Ten pages, a shell, a brand with rules about what colour may mean what — and
 * until this suite, **nothing had ever rendered any of it.** 1,758 tests passed
 * over an interface whose first viewer would have been an evaluating MSP. Every
 * other dimension this repository opened late found defects on the first run
 * (RR-081–RR-084 from chaos, RR-091 from populated upgrade, RR-095 from the
 * lifecycle comparison), and this is the last one that can be opened here.
 *
 * It drives the real interface against the real API over a real socket, in a
 * real browser. Not a render test with mocked fetches: the thing that breaks an
 * interface is usually the seam between it and the server, and a mock is a
 * second implementation of the server written by the person who wrote the
 * client.
 *
 * WHAT A FAILURE HERE MEANS
 *
 * A page that throws, a console error, a request the API refuses, or a state
 * colour used for decoration. The last one is a product rule rather than a
 * cosmetic one: green means PROVEN. A green heading on a page about something
 * unproven is Adericel lying in the one place a customer looks first.
 */

const available = await databaseAvailable();
const ROOT = join(import.meta.dirname, '..', '..');
const TEST_PASSWORD = 'Test-password-2026!';

/**
 * Chromium, from wherever this machine actually has one.
 *
 * `PLAYWRIGHT_BROWSERS_PATH` points at a browser set installed with the image,
 * and the pinned Playwright version expects a specific build number inside it.
 * When the two disagree — the image ships a newer build than the pinned library
 * asks for — the default launch fails with "Executable doesn't exist" and
 * advises running `playwright install`, which would download a second copy of
 * Chromium on every machine and is exactly what the image exists to avoid.
 *
 * So the default is tried first, and on failure the image's own binary is used
 * directly. Stated rather than silently worked around: this suite is about
 * whether the interface renders, and it should not fail for the version number
 * of a browser build.
 */
async function launch(): Promise<Browser> {
  const args = ['--no-sandbox'];
  try {
    return await chromium.launch({ args });
  } catch (error) {
    const { existsSync, readdirSync } = await import('node:fs');
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
    const candidates = existsSync(root)
      ? readdirSync(root)
          .filter((name) => name.startsWith('chromium-'))
          .map((name) => `${root}/${name}/chrome-linux64/chrome`)
          .concat(
            readdirSync(root)
              .filter((name) => name.startsWith('chromium-'))
              .map((name) => `${root}/${name}/chrome-linux/chrome`),
          )
      : [];
    const executablePath = candidates.find((candidate) => existsSync(candidate));
    if (executablePath === undefined) throw error;
    return chromium.launch({ args, executablePath });
  }
}

/**
 * Wait for the dev server AND its API proxy, or fail saying it never came up.
 *
 * Probing the HTML alone is not enough, and getting that wrong cost an hour.
 * Vite serves `index.html` before its proxy middleware will forward anything,
 * so the first POST through `/api` came back `500` with an empty body — which
 * looks exactly like the API rejecting a sign-in. The probe has to ask the
 * question the application will ask.
 */
async function waitForWeb(web: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const page = await fetch(web);
      // Any answer from the API through the proxy will do: a 404 for a path
      // that does not exist proves the proxy forwards and the API replies. A
      // 500 with an empty body is Vite's own proxy error.
      const proxied = await fetch(`${web}/api/v1/does-not-exist`);
      if (page.ok && proxied.status !== 500) return;
      lastError = new Error(`page ${page.status}, proxy ${proxied.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${web} never came up: ${String(lastError)}`);
}

/**
 * A port nothing else holds.
 *
 * A fixed port cost a second hour: a leftover dev server from an earlier run
 * answered the readiness probe while proxying to an API that no longer
 * existed, so the suite tested a stale deployment and reported a sign-in
 * failure that was not real.
 */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the probe did not bind a port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

interface Session {
  readonly harness: Harness;
  readonly tenant: SeededTenant;
  readonly web: string;
  readonly vite: ChildProcess;
  readonly browser: Browser;
}

/** Every surface the shell offers, by the path a person's browser would hold. */
function surfaces(organisationId: string): readonly { path: string; expect: RegExp }[] {
  return [
    { path: '/', expect: /portfolio/i },
    { path: '/account', expect: /account security/i },
    { path: '/control-room', expect: /control room/i },
    { path: `/organisations/${organisationId}`, expect: /in-scope controls/i },
    { path: `/organisations/${organisationId}/fix`, expect: /findings/i },
    { path: `/organisations/${organisationId}/proof`, expect: /evidence/i },
    { path: `/organisations/${organisationId}/change`, expect: /change/i },
    { path: `/organisations/${organisationId}/ask`, expect: /ask/i },
  ];
}

const RECORDS = [
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'ui-user-0',
    payload: {
      externalId: 'ui-user-0',
      displayName: 'Person With MFA',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: true,
      lastSignInAt: '2026-09-01T09:00:00.000Z',
    },
  },
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'ui-user-1',
    payload: {
      externalId: 'ui-user-1',
      displayName: 'Person Without MFA',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: false,
      lastSignInAt: '2026-09-01T09:00:00.000Z',
    },
  },
  {
    kind: 'DEVICE_STATE',
    subjectExternalId: 'ui-device-0',
    payload: {
      externalId: 'ui-device-0',
      displayName: 'A Laptop',
      managed: true,
      diskEncrypted: true,
      osVersion: '14.6.1',
      lastSeenAt: '2026-09-08T09:00:00.000Z',
    },
  },
];

describe.skipIf(!available)('the interface, rendered', () => {
  let session: Session;
  /** Everything the browser complained about, across every page this suite opens. */
  const complaints: string[] = [];

  beforeAll(async () => {
    const harness = await createHarness();
    const tenant = await seedTenant(harness, { slug: 'ui', records: RECORDS });

    // A real socket. The rest of the suite uses `server.inject`, which never
    // binds a port — and a browser cannot inject.
    await harness.server.listen({ port: 0, host: '127.0.0.1' });
    const address = harness.server.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the API did not bind a TCP port');
    }
    const apiOrigin = `http://127.0.0.1:${address.port}`;

    // Collect once, so the pages have something true to show. An interface
    // tested against an empty estate proves only that it renders nothing.
    const collected = await fetch(
      `${apiOrigin}/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      { method: 'POST', headers: { authorization: `Bearer ${await serviceToken(apiOrigin)}` } },
    ).catch(() => null);
    void collected;

    const port = await freePort();
    const vite = spawn(
      'npx',
      ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
      {
        cwd: join(ROOT, 'apps', 'web'),
        env: { ...process.env, VITE_API_PROXY_TARGET: apiOrigin },
        stdio: 'pipe',
      },
    );
    vite.stderr?.on('data', (chunk: Buffer) => {
      complaints.push(`vite: ${chunk.toString().trim()}`);
    });

    const web = `http://127.0.0.1:${port}`;
    await waitForWeb(web, 90_000);

    session = { harness, tenant, web, vite, browser: await launch() };
  }, 300_000);

  afterAll(async () => {
    await session?.browser.close().catch(() => undefined);
    session?.vite.kill('SIGTERM');
    await session?.harness.close().catch(() => undefined);
  });

  /** A page with its console and network failures recorded. */
  async function open(path: string): Promise<Page> {
    const page = await session.browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') complaints.push(`${path} console: ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      complaints.push(`${path} threw: ${error.message}`);
    });
    page.on('requestfailed', (request) => {
      /**
       * Aborts are not failures.
       *
       * Closing a page or navigating away cancels whatever the application had
       * in flight, and Chromium reports each as `net::ERR_ABORTED`. Counting
       * those made this assertion fire twenty-nine times on a run where
       * nothing was wrong — a guard that cries wolf is one somebody deletes.
       */
      const reason = request.failure()?.errorText ?? 'unknown';
      if (reason.includes('ERR_ABORTED')) return;
      complaints.push(`${path} request failed (${reason}): ${request.url()}`);
    });
    await page.goto(`${session.web}${path}`, { waitUntil: 'networkidle' });
    return page;
  }

  async function signInThroughTheInterface(page: Page): Promise<void> {
    await page.getByLabel(/email/i).fill('owner-ui@test.invalid');
    await page.getByLabel(/password/i).fill(TEST_PASSWORD);
    // The response is asserted rather than inferred from what the page then
    // shows. A 500 here used to present as "the portfolio did not render",
    // which sends you looking in the wrong place.
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/v1/auth/login')),
      page.getByRole('button', { name: /sign in/i }).click(),
    ]);
    expect(response.status(), await response.text()).toBe(200);
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /sign out/i }).waitFor({ timeout: 15_000 });
  }

  it('serves the application at all', async () => {
    const page = await open('/');
    // The premise, and the thing that had never been established: the bundle
    // builds, loads, and mounts something.
    const body = await page.locator('body').innerText();
    expect(body.trim().length, 'the page rendered nothing').toBeGreaterThan(0);
    await page.close();
  }, 120_000);

  it('asks an unauthenticated visitor to sign in, and shows them no data', async () => {
    const page = await open('/');
    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).toContain('sign in');
    // A signed-out shell that leaks an organisation name is a disclosure, not
    // a cosmetic bug.
    expect(body).not.toContain('ui ltd');
    await page.close();
  }, 120_000);

  it('signs a person in and names the room they are standing in', async () => {
    const page = await open('/');
    await signInThroughTheInterface(page);
    const body = await page.locator('body').innerText();
    // Not merely "the sign-in form went away": the shell must say whose
    // portfolio this is, because the surface is an information boundary and
    // the commonest operator error is forgetting which hat you have on.
    expect(body).toMatch(/MSP for ui/i);
    expect(body).toMatch(/portfolio/i);
    await page.close();
  }, 120_000);

  it('renders every surface the shell offers', async () => {
    /**
     * The gap that made the first version of this suite worthless: it opened
     * `/` and nothing else, so eight of the ten pages were still unrendered by
     * a suite whose entire purpose was to render them.
     */
    const page = await open('/');
    await signInThroughTheInterface(page);
    for (const surface of surfaces(session.tenant.organisationId)) {
      await page.goto(`${session.web}${surface.path}`, { waitUntil: 'networkidle' });
      const body = await page.locator('body').innerText();
      expect(body, `${surface.path} did not render its own content`).toMatch(surface.expect);
      // Every surface keeps the shell, so a page that threw during render and
      // left a blank frame cannot pass by matching a word in the chrome.
      expect(body.length, `${surface.path} rendered almost nothing`).toBeGreaterThan(120);
    }
    await page.close();
  }, 300_000);

  it('tells the MSP an unassessed customer is unknown, on the page they see first', async () => {
    /**
     * The defect this suite exists to have found (RR-096). The portfolio showed
     * `0 UNKNOWN CONTROLS` for a customer Adericel could not speak to about a
     * single control, while the assurance page one level down said sixteen.
     * `tests/e2e/unassessed-is-not-nothing-wrong.test.ts` holds the regression
     * at the API; this asserts the number actually reaches the eye.
     */
    const page = await open('/');
    await signInThroughTheInterface(page);
    // The shell renders before its data arrives, so `networkidle` is not
    // enough: without this the body still read "Loading the portfolio…" and
    // the assertion failed for the wrong reason.
    await page.getByText(/UNKNOWN CONTROLS/i).waitFor({ timeout: 20_000 });
    const portfolio = await page.locator('body').innerText();
    const unknown = /(\d+)\s*\n?\s*UNKNOWN CONTROLS/i.exec(portfolio)?.[1];
    expect(unknown, `the portfolio states no unknown count:\n${portfolio}`).toBeDefined();
    expect(
      Number(unknown),
      'a customer with no assessment at all must not read as nothing wrong',
    ).toBeGreaterThan(0);
    await page.close();
  }, 300_000);

  it('never says no evidence has been collected about an estate that holds some', async () => {
    const page = await open('/');
    await signInThroughTheInterface(page);
    await page.goto(`${session.web}/organisations/${session.tenant.organisationId}`, {
      waitUntil: 'networkidle',
    });
    const body = await page.locator('body').innerText();
    expect(body).toMatch(/never been assessed/i);
    expect(
      body,
      'this estate was collected from, so saying no evidence exists contradicts its own Proof page',
    ).not.toMatch(/No evidence has been collected/i);
    await page.close();
  }, 300_000);

  it('works at the width of a phone, without a sideways scrollbar', async () => {
    /**
     * An MSP engineer looks at this on a phone when something is on fire, and a
     * page that scrolls sideways hides the column saying what is wrong.
     */
    const page = await session.browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${session.web}/`, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the page is wider than the phone it is on').toBeLessThanOrEqual(1);
    await page.close();
  }, 120_000);

  it('uses the proven colour for nothing but proven', async () => {
    /**
     * Green means PROVEN. That is a product rule, not a cosmetic one — a green
     * heading on a page about something unproven is Adericel lying in the one
     * place a customer looks first — and until now it was asserted only in
     * prose and in a token test that never rendered anything (RR-097).
     *
     * This reads the token off the live page and then asks every element on it
     * what colour it actually ended up. An element wearing the proven colour
     * must belong to the proven family; nothing may borrow it for decoration.
     */
    const page = await open('/');
    await signInThroughTheInterface(page);
    await page.getByText(/UNKNOWN CONTROLS/i).waitFor({ timeout: 20_000 });

    const offenders = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      /** Resolve a token to the rgb() string the browser will compare against. */
      const resolve = (token: string): string => {
        const probe = document.createElement('span');
        probe.style.color = root.getPropertyValue(token).trim();
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      };
      const proven = resolve('--state-proven');
      if (proven === '' || proven === 'rgba(0, 0, 0, 0)') return ['--state-proven did not resolve'];

      const found: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>('body *')) {
        const style = getComputedStyle(element);
        const wearing = [
          style.backgroundColor,
          style.color,
          style.borderLeftColor,
          style.borderTopColor,
        ].includes(proven);
        if (!wearing) continue;
        // Anything in the proven family is entitled to it. Everything else is
        // using a state colour as decoration.
        const name = `${element.tagName.toLowerCase()}.${element.className}`;
        if (!/proven/.test(String(element.className))) found.push(name);
      }
      return found;
    });

    expect(
      offenders,
      'these elements wear the proven colour without being about something proven',
    ).toEqual([]);
    await page.close();
  }, 300_000);

  it('gives Unknown no colour at all, as the brand requires', async () => {
    /**
     * Unknown is hatched rather than coloured, because any hue would place it
     * somewhere on the good-to-bad axis and Unknown is not on that axis. The
     * presentation module says so in a comment; this is the assertion.
     */
    const page = await open('/');
    await signInThroughTheInterface(page);
    await page.goto(`${session.web}/organisations/${session.tenant.organisationId}`, {
      waitUntil: 'networkidle',
    });
    const chips = page.locator('.state--unknown');
    expect(await chips.count(), 'no Unknown chip rendered, so this proves nothing').toBeGreaterThan(
      0,
    );

    const wearing = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const resolve = (token: string): string => {
        const probe = document.createElement('span');
        probe.style.color = root.getPropertyValue(token).trim();
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      };
      const stateColours = ['--state-proven', '--state-failing', '--state-exception'].map(resolve);
      const offenders: string[] = [];
      for (const chip of document.querySelectorAll<HTMLElement>('.state--unknown')) {
        const style = getComputedStyle(chip);
        if (stateColours.includes(style.backgroundColor)) offenders.push(style.backgroundColor);
      }
      return offenders;
    });
    expect(wearing, 'an Unknown chip is wearing a state colour').toEqual([]);
    await page.close();
  }, 300_000);

  it('labels every state chip the way the presentation module says', async () => {
    /**
     * The mapping from state to word lives in exactly one module, and this
     * asserts the page honours it.
     *
     * WHAT IT CANNOT CATCH, SAID PLAINLY
     *
     * It compares the rendered page against `STATE_PRESENTATION`, which is the
     * same module the page renders from — so changing the mapping there changes
     * both sides and this stays green. What it does catch is a component that
     * stops consulting the module: a hard-coded tone, a chip built by hand, a
     * refactor that drops the lookup. That is the failure that happens; a
     * deliberate edit to the mapping is reviewed. Mutation
     * `chip-tone-stops-following-its-state` is the first case.
     */
    const page = await open('/');
    await signInThroughTheInterface(page);
    await page.goto(`${session.web}/organisations/${session.tenant.organisationId}`, {
      waitUntil: 'networkidle',
    });
    const chips = await page.locator('.state').evaluateAll((elements) =>
      elements.map((element) => ({
        label: (element.textContent ?? '').trim(),
        tone: (/state--(\w+)/.exec(String(element.className)) ?? [])[1] ?? '',
      })),
    );
    expect(chips.length, 'no state chips rendered at all').toBeGreaterThan(0);

    /** label -> the only tone it may wear, from STATE_PRESENTATION. */
    const expected = new Map<string, string>();
    for (const presentation of Object.values(STATE_PRESENTATION)) {
      expected.set(presentation.label, presentation.tone);
    }
    const wrong = chips
      // Severity chips reuse the same class and are not assurance states, so
      // only labels the presentation module owns are judged here.
      .filter((chip) => expected.has(chip.label))
      .filter((chip) => expected.get(chip.label) !== chip.tone)
      .map((chip) => `${chip.label} rendered as ${chip.tone}`);
    expect(wrong, 'a state chip is wearing the wrong tone for its word').toEqual([]);
    await page.close();
  }, 300_000);

  it('opened every page without the browser complaining once', () => {
    /**
     * Deliberately last, and deliberately an assertion rather than a log.
     *
     * A console error is the interface telling you it is broken in the one
     * channel nobody reads. Collected across every page this suite opened, so
     * a page that renders and throws cannot pass by rendering.
     */
    expect(complaints, 'the browser complained').toEqual([]);
  });
});

/**
 * A token for the setup collection, obtained the way a person would.
 *
 * Signing in over HTTP rather than reaching into the database, because setup
 * that bypasses the API can succeed against a server that would refuse a
 * person — which is how a suite ends up testing a path nobody has.
 */
async function serviceToken(apiOrigin: string): Promise<string> {
  const response = await fetch(`${apiOrigin}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner-ui@test.invalid', password: TEST_PASSWORD }),
  });
  const body = (await response.json()) as { accessToken?: string };
  if (!response.ok || !body.accessToken) {
    throw new Error(`setup sign-in failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.accessToken;
}
