import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Brand validation — Brand Pack v1.2 §28.
 *
 * The specification asks for automated validation of colour, SVG hygiene,
 * distribution lockups, asset presence, naming and determinism. This is it.
 *
 * The reason it exists: a brand contract with a designer who is not in the room
 * does not break by decision. It breaks by somebody nudging a hex to match a
 * screenshot six months from now, with no way to notice. When the pack is
 * revised, this file is revised with it deliberately, and the diff shows the
 * change as a change rather than as a stylistic tweak.
 */

const tokensPath = fileURLToPath(new URL('../../apps/web/src/styles/tokens.css', import.meta.url));
const appCssPath = fileURLToPath(new URL('../../apps/web/src/styles/app.css', import.meta.url));

const tokens = await readFile(tokensPath, 'utf8');
const appCss = await readFile(appCssPath, 'utf8');

/** The value of a custom property in the bare `:root` block. */
function rootToken(name: string): string | null {
  const root = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('\n}'));
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(root);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

describe('v1.2 §22 — canonical colours', () => {
  const published: ReadonlyArray<readonly [string, string]> = [
    ['--c-ink', '#14181f'],
    ['--c-paper', '#fbfbf9'],
    ['--c-slate', '#5a6270'],
    ['--c-proven', '#1e5540'],
    ['--c-failing', '#a33326'],
    ['--c-exception', '#96601a'],
    ['--c-rule', '#dcddd8'],
  ];

  for (const [name, hex] of published) {
    it(`${name} is ${hex}`, () => {
      expect(rootToken(name)).toBe(hex);
    });
  }

  it('carries the current exception colour, not the v1.0 amber', () => {
    // #D08B2F sat close enough to a warning yellow to be read as one. The spec
    // separately forbids turning Unknown into warning yellow, so an Exception
    // that looked like a warning reintroduced the same confusion one state on.
    expect(tokens.toLowerCase()).not.toContain('#d08b2f');
  });
});

describe('v1.2 §11 — typography', () => {
  it('names Inter for the interface and IBM Plex Mono for data', () => {
    expect(rootToken('--font-ui')).toContain('inter');
    expect(rootToken('--font-data')).toContain('ibm plex mono');
  });

  it('bundles both faces rather than fetching them', async () => {
    // The production CSP sets font-src 'self'. A Google Fonts link renders the
    // whole interface in a system fallback and says nothing about it, so the
    // brand would be silently absent from the only deployment that matters.
    const html = await readFile(
      fileURLToPath(new URL('../../apps/web/index.html', import.meta.url)),
      'utf8',
    );
    // Matched as an actual link rather than as a bare string: the file
    // explains in a comment why the fonts are bundled, and that comment names
    // the hosts. A test that cannot tell an explanation from a stylesheet would
    // fail the moment somebody documents the decision.
    expect(html).not.toMatch(/<link[^>]+href="https:\/\/fonts\./);
    expect(html).not.toMatch(/@import[^;]*fonts\.(googleapis|gstatic)/);

    const main = await readFile(
      fileURLToPath(new URL('../../apps/web/src/main.tsx', import.meta.url)),
      'utf8',
    );
    expect(main).toContain('@fontsource');
  });
});

describe('v1.2 §24 — the DON’T column, enforced', () => {
  it('spends no state colour on anything that is not a state', () => {
    // Green means proven. A green button, a green accent or a green app icon
    // spends the one colour that carries meaning on something that carries
    // none — which is why the pack lists it as a DON'T rather than a taste.
    const brandTokens = ['--c-proven', '--c-failing', '--c-exception'];
    const stateContext = /state|count-bar|notice--|severity/i;

    const offenders = appCss
      .split('\n')
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(
        (entry) =>
          brandTokens.some((token) => entry.line.includes(token)) && !stateContext.test(entry.line),
      );

    expect(offenders, 'state colour used outside a state context').toEqual([]);
  });

  it('uses no shadows and no gradients other than the hatch', () => {
    expect(appCss).not.toMatch(/box-shadow:\s*(?!none)/);
    const gradients = [...appCss.matchAll(/[a-z-]*gradient\(/g)].map((m) => m[0]);
    // The hatch is a repeating-linear-gradient and is the only one permitted.
    expect(gradients.every((g) => g === 'repeating-linear-gradient(')).toBe(true);
  });

  it('renders Unknown with no colour at all', () => {
    const unknown = appCss.slice(appCss.indexOf('.state--unknown {'));
    const block = unknown.slice(0, unknown.indexOf('}'));
    // currentColor and transparent only. Any hue here is the failure mode the
    // whole product exists to avoid.
    expect(block).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(block).not.toContain('--state-');
  });
});

describe('v1.2 §3 — the mark', () => {
  it('carries no green', async () => {
    const mark = await readFile(
      fileURLToPath(new URL('../../apps/web/src/components/Mark.tsx', import.meta.url)),
      'utf8',
    );
    expect(mark).not.toContain('state-proven');
    expect(mark).not.toContain('c-proven');
  });

  it('hatches the middle bar, because that is the thesis', async () => {
    const mark = await readFile(
      fileURLToPath(new URL('../../apps/web/src/components/Mark.tsx', import.meta.url)),
      'utf8',
    );
    expect(mark).toContain('hatched: true');
  });

  it('draws the generated assets from the same three bars', async () => {
    const generated = await readFile(
      fileURLToPath(new URL('../../brand/mark/adericel-mark-light.svg', import.meta.url)),
      'utf8',
    );
    // If these diverge, the mark in the product and the mark in a customer's
    // deck stop being the same mark.
    expect(generated).toContain('M0 40 L16 0 H26 L10 40 Z');
    expect(generated).toContain('#14181F');
    expect(generated).toContain('pattern');
  });

  it('draws the mono asset solid, not hatched', async () => {
    const mono = await readFile(
      fileURLToPath(new URL('../../brand/mark/adericel-mark-mono-dark.svg', import.meta.url)),
      'utf8',
    );
    // At one colour and small sizes the hatch fills in and reads as a muddy
    // block, which is worse than an honest solid.
    expect(mono).not.toContain('pattern');
  });
});

/* ═════════════════════════════════════ v1.2 §28 — asset production validation */

const BRAND_DIR = fileURLToPath(new URL('../../brand/', import.meta.url));

/** The §17 structure. Every one of these is required to exist. */
const REQUIRED_ASSETS = [
  'logo/adericel-logo-light.svg',
  'logo/adericel-logo-dark.svg',
  'logo/adericel-logo-mono-dark.svg',
  'logo/adericel-logo-mono-light.svg',
  'mark/adericel-mark-light.svg',
  'mark/adericel-mark-dark.svg',
  'mark/adericel-mark-mono-dark.svg',
  'mark/adericel-mark-mono-light.svg',
  'favicon/favicon.svg',
  'favicon/favicon-16.png',
  'favicon/favicon-32.png',
  'favicon/favicon-48.png',
  'app/app-icon.svg',
  'app/app-icon-light-1024.png',
  'app/app-icon-dark-1024.png',
  'brand-source.yml',
] as const;

async function read(relative: string): Promise<string> {
  return readFile(`${BRAND_DIR}${relative}`, 'utf8');
}

const svgAssets = REQUIRED_ASSETS.filter((file) => file.endsWith('.svg'));
const distributionLockups = REQUIRED_ASSETS.filter((file) => file.startsWith('logo/'));

describe('v1.2 §8 — the invalid exception value', () => {
  it('appears nowhere in the repository', async () => {
    // The v1.1 sheet printed an eight-character string for --c-exception that
    // is not a valid hex colour. §8 requires it removed from the entire
    // repository including generated asset metadata, so this walks the tracked
    // tree rather than checking the files this suite happens to know about.
    const { execFileSync } = await import('node:child_process');
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

    const banned = ['#', '9', '6', '6', '6', '0', '1', 'A'].join('');
    const offenders: string[] = [];
    for (const file of tracked) {
      if (file.endsWith('.png') || file.endsWith('.woff2')) continue;
      try {
        const content = await readFile(`${repo}${file}`, 'utf8');
        if (content.toUpperCase().includes(banned)) offenders.push(file);
      } catch {
        // Binary or unreadable; nothing to check.
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('v1.2 §17 — required assets exist under canonical names', () => {
  for (const file of REQUIRED_ASSETS) {
    it(`${file} exists`, async () => {
      await expect(readFile(`${BRAND_DIR}${file}`)).resolves.toBeDefined();
    });
  }

  it('uses no ambiguous names', async () => {
    // §15 rejects logo-black, logo-white, logo-green, logo-final and the rest.
    // The variants are named for the surface they belong on, which is
    // information; "final" is not.
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(BRAND_DIR, { recursive: true, withFileTypes: true });
    const names = entries.filter((e) => e.isFile()).map((e) => e.name.toLowerCase());
    const ambiguous = names.filter((name) =>
      /(black|white|green|final|new|old|copy|v\d|latest)/.test(name),
    );
    expect(ambiguous).toEqual([]);
  });
});

describe('v1.2 §18/§19 — SVGs are genuine vectors', () => {
  for (const file of svgAssets) {
    it(`${file} is a clean, scalable vector`, async () => {
      const content = await read(file);

      // Valid XML, and specifically an SVG root.
      expect(content.trimStart().startsWith('<svg')).toBe(true);
      expect(content.trimEnd().endsWith('</svg>')).toBe(true);

      // §19 — explicit viewBox, no baked display size.
      expect(content).toMatch(/viewBox="0 0 [\d.]+ [\d.]+"/);

      // §18 — no embedded raster, no base64 payload, no external dependency.
      expect(content).not.toContain('<image');
      expect(content).not.toContain('base64');
      expect(content).not.toMatch(/href="https?:/);
      expect(content).not.toContain('<filter');
      expect(content).not.toContain('<mask');
    });
  }
});

describe('v1.2 §6/§18 — distribution lockups are self-contained', () => {
  for (const file of distributionLockups) {
    it(`${file} carries outlined geometry, not live text`, async () => {
      const content = await read(file);
      // A recipient without Inter would otherwise get the wordmark silently
      // re-set in Arial. The outlines come from the Inter binary, so they are
      // exact rather than a trace.
      expect(content).not.toContain('<text');
      expect(content).not.toContain('font-family');
      // And it must actually contain wordmark geometry rather than just a mark.
      const pathCount = [...content.matchAll(/<path /g)].length;
      expect(pathCount).toBeGreaterThan(3);
    });
  }
});

describe('v1.2 §14 — the favicon is a designed derivative', () => {
  it('uses the simplified two-bar geometry, not the scaled master', async () => {
    const favicon = await read('favicon/favicon.svg');
    const master = await read('mark/adericel-mark-light.svg');

    const faviconPaths = [...favicon.matchAll(/<path /g)].length;
    const masterPaths = [...master.matchAll(/<path /g)].length;

    expect(faviconPaths).toBe(2);
    expect(masterPaths).toBe(3);
    // At 16px a 5-unit hatch pitch is finer than the pixel grid and aliases
    // into a smear that reads as a rendering fault rather than as texture.
    expect(favicon).not.toContain('pattern');
  });
});

describe('v1.2 §26 — provenance is recorded', () => {
  it('declares the geometry status honestly', async () => {
    const source = await read('brand-source.yml');
    expect(source).toContain("brand_version: '1.2'");
    // §29 — until the official vector master is supplied this must not be
    // described as authoritative, and nothing in the repository may call it
    // official, final, canonical or source artwork.
    expect(source).toMatch(/geometry_status: '(provisional|authoritative)'/);
  });

  it('records a hash for every generated asset', async () => {
    const source = await read('brand-source.yml');
    for (const file of REQUIRED_ASSETS) {
      if (file === 'brand-source.yml') continue;
      expect(source, `${file} is not in the manifest`).toContain(file);
    }
    expect([...source.matchAll(/sha256: '[0-9a-f]{64}'/g)].length).toBeGreaterThanOrEqual(
      REQUIRED_ASSETS.length - 1,
    );
  });
});

describe('v1.2 §28 — the builder is deterministic', () => {
  it('produces byte-identical output when run twice', async () => {
    // A brand pipeline whose output changes between runs cannot be reviewed:
    // every regeneration shows a diff, so a real change hides among them.
    const { execFileSync } = await import('node:child_process');
    const { createHash } = await import('node:crypto');
    const repo = fileURLToPath(new URL('../../', import.meta.url));

    const fingerprint = async (): Promise<string> => {
      const hash = createHash('sha256');
      for (const file of [...REQUIRED_ASSETS].sort()) {
        hash.update(file);
        hash.update(await readFile(`${BRAND_DIR}${file}`));
      }
      return hash.digest('hex');
    };

    const before = await fingerprint();
    execFileSync('pnpm', ['brand:build'], { cwd: repo, stdio: 'pipe' });
    const after = await fingerprint();

    expect(after).toBe(before);
  }, 60_000);
});

describe('state colour is never decoration', () => {
  /**
   * Green means PROVEN. Amber means EXCEPTION. Red means NOT SATISFIED.
   *
   * A product whose colours carry meaning has to spend them carefully: the
   * moment green also underlines the active tab, or brightens a heading, the
   * reader learns it is decorative and stops reading it as a determination.
   *
   * This finds every use of a state token and requires it to sit in a selector
   * that is actually about state.
   */
  const STATE_CONTEXT =
    /(state|proven|failing|exception|unknown|satisfied|tone|notice|count-bar|severity|meter|outcome|--PASS|--FAIL)/i;

  /**
   * Uses that carry meaning on a different axis, each with its reason.
   *
   * A destructive-action button is red because the action is dangerous, not
   * because a control failed. Reusing the same red keeps the palette coherent
   * and is a deliberate decision — recorded here rather than silently allowed
   * by a loose pattern.
   */
  const ALLOWED_NON_STATE: Record<string, string> = {
    '.button--danger': 'A destructive action. Red for danger, not for a determination.',
  };

  it('uses state tokens only in selectors that are about state', () => {
    const css = appCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders: string[] = [];

    // Walk rule by rule, so a declaration is judged by the selector it is in.
    for (const block of css.split('}')) {
      const [selectorPart, declarations] = block.split('{');
      if (!selectorPart || !declarations) continue;
      if (!/var\(--state-(proven|failing|exception)/.test(declarations)) continue;

      const selector = selectorPart
        .split('\n')
        .filter((line) => !line.trim().startsWith('*'))
        .join(' ')
        .trim();
      if (STATE_CONTEXT.test(selector)) continue;
      if (ALLOWED_NON_STATE[selector] !== undefined) continue;
      offenders.push(selector);
    }

    expect(offenders).toEqual([]);
  });

  it('does not tint the active navigation with a determination colour', () => {
    // The specific case this test was written for: the active tab was
    // underlined in the green that means PROVEN.
    // Comments stripped first: this rule explains in prose why it does NOT use
    // the proven green, and matching that sentence would fail the test for
    // saying the right thing.
    const withoutComments = appCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.nav__link--active\s*\{[\s\S]*?\}/.exec(withoutComments)?.[0] ?? '';
    expect(rule).not.toMatch(/--state-(proven|failing|exception)/);
  });
});
