import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The brand, asserted.
 *
 * Brand Pack v1.1 publishes seven colours and two typefaces. They are a
 * contract with a designer who is not in the room, and the usual way that
 * contract breaks is not a decision — it is somebody nudging a hex while
 * matching a screenshot, six months from now, with no way to notice.
 *
 * This is a cheap test that makes drift a build failure. When the brand pack is
 * revised, this file is revised with it, deliberately, and the diff shows the
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

describe('Brand Pack v1.1 colours', () => {
  const published: ReadonlyArray<readonly [string, string]> = [
    ['--c-ink', '#14181f'],
    ['--c-paper', '#fbfbf9'],
    ['--c-slate', '#5a6270'],
    ['--c-proven', '#1e5540'],
    ['--c-failing', '#a33326'],
    ['--c-exception', '#96601a'],
    ['--c-rule', '#dcdbd8'],
  ];

  for (const [name, hex] of published) {
    it(`${name} is ${hex}`, () => {
      expect(rootToken(name)).toBe(hex);
    });
  }

  it('carries the v1.1 exception colour, not the v1.0 amber', () => {
    // #D08B2F sat close enough to a warning yellow to be read as one. The pack
    // separately forbids turning Unknown into warning yellow, so an Exception
    // that looked like a warning reintroduced the same confusion one state on.
    expect(tokens.toLowerCase()).not.toContain('#d08b2f');
  });
});

describe('Brand Pack v1.1 typography', () => {
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

describe('the DON’T column, enforced', () => {
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

describe('the mark', () => {
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
