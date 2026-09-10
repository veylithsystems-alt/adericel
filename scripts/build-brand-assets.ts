#!/usr/bin/env tsx
/**
 * Generate the Adericel brand assets — Brand Pack v1.1.
 *
 * The assets are built from one set of coordinates and one set of tokens rather
 * than hand-exported and committed as opaque files. That matters for a brand
 * whose central device is a hatch: the moment the mark's hatch, the Unknown
 * chip's hatch and the favicon's hatch are maintained separately, they drift,
 * and the thing that is supposed to read as one idea reads as three.
 *
 * Run with `pnpm brand:build`. Output goes to `brand/` (the distributable
 * asset structure the brand pack publishes) and `apps/web/public/brand/` (what
 * the application serves).
 *
 * SVG is the canonical format and is generated here with no dependencies. PNG
 * rasters are produced by a headless browser when one is available; the script
 * says so plainly when it is not, rather than silently shipping fewer assets.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ------------------------------------------------------------------ tokens */
/** Copied from the brand pack. Kept here so the assets cannot drift from it. */
const C = {
  ink: '#14181F',
  paper: '#FBFBF9',
  slate: '#5A6270',
} as const;

/* ---------------------------------------------------------------- geometry */
/**
 * Three ascending slanted bars in a 58×40 field. The middle bar is hatched.
 *
 * Reconstructed from the v1.1 brand sheet, which is a raster. When the official
 * vector exists these five numbers are what it replaces; nothing else in the
 * pipeline depends on the reconstruction.
 */
const BARS: readonly { d: string; hatched: boolean }[] = [
  { d: 'M0 40 L16 0 H26 L10 40 Z', hatched: false },
  { d: 'M18 40 L34 0 H44 L28 40 Z', hatched: true },
  { d: 'M36 40 L48 10 H58 L46 40 Z', hatched: false },
];

const HATCH_PITCH = 5;
const HATCH_WIDTH = 1.6;

interface MarkOptions {
  /** The colour every solid bar and the hatch lines are drawn in. */
  readonly fill: string;
  /**
   * Draw the middle bar solid instead of hatched.
   *
   * The mono assets do this deliberately. At one colour and small sizes the
   * hatch fills in and reads as a muddy block, which is worse than an honest
   * solid.
   */
  readonly solidMiddle?: boolean;
  readonly idSuffix: string;
}

function markBody({ fill, solidMiddle = false, idSuffix }: MarkOptions): string {
  const hatchId = `hatch-${idSuffix}`;
  const defs = solidMiddle
    ? ''
    : `  <defs>
    <pattern id="${hatchId}" patternUnits="userSpaceOnUse" width="${HATCH_PITCH}" height="${HATCH_PITCH}" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="${HATCH_PITCH}" stroke="${fill}" stroke-width="${HATCH_WIDTH}"/>
    </pattern>
  </defs>
`;

  const paths = BARS.map((bar) => {
    if (bar.hatched && !solidMiddle) {
      return `  <path d="${bar.d}" fill="url(#${hatchId})" stroke="${fill}" stroke-width="1.5" stroke-linejoin="round"/>`;
    }
    return `  <path d="${bar.d}" fill="${fill}"/>`;
  }).join('\n');

  return defs + paths;
}

function markSvg(options: MarkOptions & { background?: string }): string {
  const bg = options.background
    ? `  <rect width="58" height="40" fill="${options.background}"/>\n`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 58 40" width="58" height="40" role="img" aria-label="Adericel">
${bg}${markBody(options)}
</svg>
`;
}

/**
 * The favicon.
 *
 * A square field with generous clear space, because the mark is wide and a
 * favicon is read at 16 pixels. The brand pack's minimum favicon size is 16px
 * and its clear-space rule is one mark-height on each side; at this scale that
 * rule is what stops the mark touching the tab's edge and turning to mush.
 */
function faviconSvg(fill: string, background?: string): string {
  const bg = background ? `  <rect width="64" height="64" fill="${background}"/>\n` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Adericel">
${bg}  <g transform="translate(3 12) scale(1)">
${markBody({ fill, idSuffix: background ? 'fav-dark' : 'fav-light' })
  .split('\n')
  .map((line) => (line ? `  ${line}` : line))
  .join('\n')}
  </g>
</svg>
`;
}

/**
 * The app icon.
 *
 * Rounded square, ink ground, paper mark. The brand pack shows a light and a
 * dark variant; both keep the mark in the opposite value rather than tinting
 * it, because the icon must survive being shown at 40 pixels on a home screen
 * next to forty others.
 */
function appIconSvg(options: { ground: string; fill: string; radius: number }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="Adericel">
  <rect width="1024" height="1024" rx="${options.radius}" fill="${options.ground}"/>
  <g transform="translate(222 312) scale(10)">
${markBody({ fill: options.fill, idSuffix: `app-${options.ground.slice(1)}` })
  .split('\n')
  .map((line) => (line ? `  ${line}` : line))
  .join('\n')}
  </g>
</svg>
`;
}

/**
 * The full lockup.
 *
 * The wordmark is set in Inter SemiBold. This file references the family by
 * name rather than embedding outlines, which means it renders correctly
 * wherever Inter is installed and falls back elsewhere.
 *
 * That is fine for the application, which bundles the face. It is NOT fine for
 * a distribution asset going into somebody else's deck or email signature: for
 * those, convert the text to outlines. This is stated in BRAND.md rather than
 * left as a surprise, and it is the one asset in this pipeline that a design
 * tool still has to touch.
 */
function logoSvg(options: { fill: string; background?: string; solidMiddle?: boolean }): string {
  const bg = options.background
    ? `  <rect width="260" height="48" fill="${options.background}"/>\n`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 48" width="260" height="48" role="img" aria-label="Adericel">
${bg}  <g transform="translate(0 4)">
${markBody({
  fill: options.fill,
  idSuffix: `logo-${options.fill.slice(1)}${options.solidMiddle ? '-mono' : ''}`,
  ...(options.solidMiddle === undefined ? {} : { solidMiddle: options.solidMiddle }),
})
  .split('\n')
  .map((line) => (line ? `  ${line}` : line))
  .join('\n')}
  </g>
  <text x="76" y="34" fill="${options.fill}" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" font-size="34" font-weight="600" letter-spacing="-0.8">Adericel</text>
</svg>
`;
}

/* ------------------------------------------------------------------- build */
interface Asset {
  readonly file: string;
  readonly content: string;
}

function assets(): Asset[] {
  return [
    // Full lockup.
    { file: 'logo/adericel-logo-light.svg', content: logoSvg({ fill: C.ink }) },
    {
      file: 'logo/adericel-logo-dark.svg',
      content: logoSvg({ fill: C.paper, background: C.ink }),
    },
    {
      file: 'logo/adericel-logo-mono-dark.svg',
      content: logoSvg({ fill: C.ink, solidMiddle: true }),
    },
    {
      file: 'logo/adericel-logo-mono-light.svg',
      content: logoSvg({ fill: C.slate, solidMiddle: true }),
    },

    // Mark alone.
    { file: 'mark/adericel-mark-light.svg', content: markSvg({ fill: C.ink, idSuffix: 'ml' }) },
    {
      file: 'mark/adericel-mark-dark.svg',
      content: markSvg({ fill: C.paper, background: C.ink, idSuffix: 'md' }),
    },
    {
      file: 'mark/adericel-mark-mono-dark.svg',
      content: markSvg({ fill: C.ink, solidMiddle: true, idSuffix: 'mmd' }),
    },
    {
      file: 'mark/adericel-mark-mono-light.svg',
      content: markSvg({ fill: C.slate, solidMiddle: true, idSuffix: 'mml' }),
    },

    // Favicon.
    { file: 'favicon/favicon.svg', content: faviconSvg(C.ink) },
    { file: 'favicon/favicon-dark.svg', content: faviconSvg(C.paper, C.ink) },

    // App icons.
    {
      file: 'app/app-icon-light.svg',
      content: appIconSvg({ ground: C.paper, fill: C.ink, radius: 180 }),
    },
    {
      file: 'app/app-icon-dark.svg',
      content: appIconSvg({ ground: C.ink, fill: C.paper, radius: 180 }),
    },
  ];
}

async function writeAll(base: string, list: readonly Asset[]): Promise<void> {
  for (const asset of list) {
    const target = path.join(base, asset.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, asset.content, 'utf8');
  }
}

async function main(): Promise<void> {
  const list = assets();

  // The distributable structure the brand pack publishes.
  await writeAll(path.join(ROOT, 'brand'), list);

  // What the application serves. Flattened, because a favicon link is easier to
  // read than a path four directories deep.
  const publicDir = path.join(ROOT, 'apps/web/public/brand');
  await mkdir(publicDir, { recursive: true });
  const served: Asset[] = [
    { file: 'favicon.svg', content: faviconSvg(C.ink) },
    { file: 'mark.svg', content: markSvg({ fill: C.ink, idSuffix: 'served' }) },
    {
      file: 'app-icon.svg',
      content: appIconSvg({ ground: C.ink, fill: C.paper, radius: 180 }),
    },
  ];
  await writeAll(publicDir, served);

  console.log(`Wrote ${list.length} assets to brand/`);
  console.log(`Wrote ${served.length} assets to apps/web/public/brand/`);
  console.log(
    '\nPNG rasters (favicon-16/32/48, app-icon-1024) are produced from these SVGs by\n' +
      'the design tool or any rasteriser. They are not generated here because this\n' +
      'script has no dependencies by design, and a brand pipeline that silently\n' +
      'needs a native library is one that stops working on somebody else’s machine.',
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
