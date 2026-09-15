#!/usr/bin/env tsx
/**
 * Adericel brand asset pipeline — Brand Pack v1.2.
 *
 * v1.2 is an asset-production specification rather than a redesign. Its central
 * rule is that three things must not be conflated: the brand specification, the
 * official vector master, and the generated derivatives. This file is the third
 * of those. It generates every derivative from one geometry definition and one
 * token block, so that when the official vector master arrives the change is a
 * geometry substitution and nothing else.
 *
 *   OFFICIAL VECTOR MASTER → validate → variants → small-scale derivatives
 *   → raster exports → validate → commit
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GEOMETRY STATUS: PROVISIONAL
 *
 * The bar coordinates in `MARK_BARS` below are RECONSTRUCTED from the raster
 * brand sheet. Per v1.2 §29 they are provisional and reference only. They are
 * not the official master, not canonical, and not source artwork, and must not
 * be described as any of those.
 *
 * When the official vector master is supplied: replace `MARK_BARS` and
 * `FAVICON_BARS`, set `geometry_status` in the manifest to `authoritative`,
 * regenerate, validate, and commit. Nothing else in this pipeline should need
 * to change — that is what it is for.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Run with `pnpm brand:build`.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import * as fontkit from 'fontkit';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ═══════════════════════════════════════════════════════════ v1.2 §22 tokens */
/** Copied from the specification. The assets cannot drift from it. */
const C = {
  ink: '#14181F',
  paper: '#FBFBF9',
  slate: '#5A6270',
  proven: '#1E5540',
  failing: '#A33326',
  exception: '#96601A',
  rule: '#DCDDD8',
} as const;

/* ══════════════════════════════════════════════════════ provisional geometry */
/**
 * The master mark: SOLID / HATCHED / SOLID.
 *
 * v1.2 §3 — the three elements read PROVEN → UNKNOWN → PROVEN. The hatch is a
 * semantic element of the identity, not decoration, which is why the middle bar
 * is textured rather than merely a different colour.
 */
const MARK_BARS: readonly { readonly d: string; readonly hatched: boolean }[] = [
  { d: 'M0 40 L16 0 H26 L10 40 Z', hatched: false },
  { d: 'M18 40 L34 0 H44 L28 40 Z', hatched: true },
  { d: 'M36 40 L48 10 H58 L46 40 Z', hatched: false },
];
const MARK_VIEWBOX = { width: 58, height: 40 } as const;

/**
 * The favicon derivative: two bars, both solid.
 *
 * v1.2 §14 requires a dedicated simplified derivative rather than the master
 * scaled down, and this is why. At 16 pixels a 5-unit hatch pitch is finer than
 * the pixel grid: it aliases into a grey smear that reads as a rendering fault
 * rather than as texture, and the three-bar silhouette closes up into a block.
 *
 * The simplification keeps the semantic by moving it from texture to negative
 * space. Two solid bars with a deliberate gap between them still say
 * established / gap / established at a size where no texture survives. It is a
 * designed derivative, not a degraded master.
 */
const FAVICON_BARS: readonly { readonly d: string }[] = [
  { d: 'M0 40 L16 0 H28 L12 40 Z' },
  { d: 'M34 40 L50 0 H62 L46 40 Z' },
];
const FAVICON_VIEWBOX = { width: 62, height: 40 } as const;

const HATCH_PITCH = 5;
const HATCH_STROKE = 1.6;

/* ═══════════════════════════════════════════════════════════════ svg helpers */

type Treatment = 'hatched' | 'solid';

interface MarkOptions {
  readonly fill: string;
  /**
   * v1.2 §21 — below the minimum size the appropriate derivative is used rather
   * than the master shrunk. `solid` is also what the mono variants use: at a
   * single colour the hatch fills in, which is why the pack ships them
   * separately rather than leaving it to chance.
   */
  readonly treatment: Treatment;
  readonly idSuffix: string;
}

function hatchPattern(id: string, fill: string): string {
  return `  <defs>
    <pattern id="${id}" patternUnits="userSpaceOnUse" width="${HATCH_PITCH}" height="${HATCH_PITCH}" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="${HATCH_PITCH}" stroke="${fill}" stroke-width="${HATCH_STROKE}"/>
    </pattern>
  </defs>
`;
}

function markPaths({ fill, treatment, idSuffix }: MarkOptions): string {
  const hatchId = `hatch-${idSuffix}`;
  const usesHatch = treatment === 'hatched' && MARK_BARS.some((bar) => bar.hatched);
  const defs = usesHatch ? hatchPattern(hatchId, fill) : '';

  const paths = MARK_BARS.map((bar) =>
    bar.hatched && treatment === 'hatched'
      ? `  <path d="${bar.d}" fill="url(#${hatchId})" stroke="${fill}" stroke-width="1.5" stroke-linejoin="round"/>`
      : `  <path d="${bar.d}" fill="${fill}"/>`,
  ).join('\n');

  return defs + paths;
}

function indent(block: string, by = '  '): string {
  return block
    .split('\n')
    .map((line) => (line ? by + line : line))
    .join('\n');
}

/** v1.2 §19 — every asset carries an explicit viewBox and no baked display size. */
function svg(viewBox: { width: number; height: number }, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox.width} ${viewBox.height}" role="img" aria-label="Adericel">
${body}
</svg>
`;
}

function markSvg(options: MarkOptions & { background?: string }): string {
  const bg = options.background
    ? `  <rect width="${MARK_VIEWBOX.width}" height="${MARK_VIEWBOX.height}" fill="${options.background}"/>\n`
    : '';
  return svg(MARK_VIEWBOX, bg + markPaths(options));
}

function faviconSvg(fill: string, background?: string): string {
  const bg = background
    ? `  <rect width="${FAVICON_VIEWBOX.width}" height="${FAVICON_VIEWBOX.height}" fill="${background}"/>\n`
    : '';
  const paths = FAVICON_BARS.map((bar) => `  <path d="${bar.d}" fill="${fill}"/>`).join('\n');
  return svg(FAVICON_VIEWBOX, bg + paths);
}

/**
 * The app icon. v1.2 §13 — the icon represents the brand, so its ground is ink
 * or paper and never Proven green: green means an assurance state, and an icon
 * is not in a state.
 */
function appIconSvg(ground: string, fill: string): string {
  const body = `  <rect width="1024" height="1024" rx="180" fill="${ground}"/>
  <g transform="translate(222 312) scale(10)">
${indent(markPaths({ fill, treatment: 'hatched', idSuffix: `app-${fill.slice(1)}` }))}
  </g>`;
  return svg({ width: 1024, height: 1024 }, body);
}

/* ═══════════════════════════════════════════════════════ outlined wordmark */

/**
 * Convert "Adericel" to vector path geometry using the real Inter SemiBold
 * outlines.
 *
 * v1.2 §6 and §18 require distribution lockups to be self-contained: an asset
 * going into somebody else's deck must not silently re-set itself in Arial
 * because they do not have Inter. `<text>` cannot satisfy that, so the wordmark
 * is outlined here from the actual font binary.
 *
 * This is glyph geometry read from Inter, not a trace of a picture of Inter, so
 * it is exact and deterministic. It is nonetheless subject to §2: when the
 * official vector master defines outlined wordmark geometry, that becomes
 * authoritative and this is replaced by it.
 */
function outlineWordmark(text: string, fontSize: number): { path: string; width: number } {
  const font = fontkit.openSync(
    path.join(ROOT, 'node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2'),
  ) as fontkit.Font;

  const run = font.layout(text);
  const scale = fontSize / font.unitsPerEm;

  let x = 0;
  const parts: string[] = [];
  run.glyphs.forEach((glyph, index) => {
    const position = run.positions[index]!;
    // The glyph path is in font units with a y-up axis; SVG is y-down, so the
    // scale is negated vertically and the run is translated to a baseline.
    const placed = glyph.path
      .translate(position.xOffset ?? 0, position.yOffset ?? 0)
      .scale(scale, -scale)
      .translate(x, 0);
    const d = placed.toSVG();
    if (d) parts.push(d);
    x += (position.xAdvance ?? 0) * scale;
  });

  return { path: parts.join(' '), width: x };
}

const WORDMARK_SIZE = 34;
const WORDMARK_GAP = 18;
const LOCKUP_BASELINE = 34;

/**
 * The full lockup. v1.2 §6 — the mark/wordmark relationship stays constant
 * across every variant, so both are placed from the same two constants above.
 */
function logoSvg(options: { fill: string; background?: string; treatment: Treatment }): string {
  const wordmark = outlineWordmark('Adericel', WORDMARK_SIZE);
  const markWidth = MARK_VIEWBOX.width;
  const totalWidth = Math.ceil(markWidth + WORDMARK_GAP + wordmark.width);
  const height = 48;

  const bg = options.background
    ? `  <rect width="${totalWidth}" height="${height}" fill="${options.background}"/>\n`
    : '';

  const body = `${bg}  <g transform="translate(0 4)">
${indent(
  markPaths({
    fill: options.fill,
    treatment: options.treatment,
    idSuffix: `logo-${options.fill.slice(1)}-${options.treatment}`,
  }),
)}
  </g>
  <path transform="translate(${markWidth + WORDMARK_GAP} ${LOCKUP_BASELINE})" d="${wordmark.path}" fill="${options.fill}"/>`;

  return svg({ width: totalWidth, height }, body);
}

/* ═══════════════════════════════════════════════════════════════════ output */

interface Asset {
  readonly file: string;
  readonly content: string;
}

/** v1.2 §15/§16/§17 — canonical names, no logo-black / logo-final / logo-green. */
function vectorAssets(): Asset[] {
  return [
    {
      file: 'logo/adericel-logo-light.svg',
      content: logoSvg({ fill: C.ink, treatment: 'hatched' }),
    },
    {
      file: 'logo/adericel-logo-dark.svg',
      content: logoSvg({ fill: C.paper, background: C.ink, treatment: 'hatched' }),
    },
    {
      file: 'logo/adericel-logo-mono-dark.svg',
      content: logoSvg({ fill: C.ink, treatment: 'solid' }),
    },
    {
      file: 'logo/adericel-logo-mono-light.svg',
      content: logoSvg({ fill: C.paper, treatment: 'solid' }),
    },

    {
      file: 'mark/adericel-mark-light.svg',
      content: markSvg({ fill: C.ink, treatment: 'hatched', idSuffix: 'ml' }),
    },
    {
      file: 'mark/adericel-mark-dark.svg',
      content: markSvg({ fill: C.paper, background: C.ink, treatment: 'hatched', idSuffix: 'md' }),
    },
    {
      file: 'mark/adericel-mark-mono-dark.svg',
      content: markSvg({ fill: C.ink, treatment: 'solid', idSuffix: 'mmd' }),
    },
    {
      file: 'mark/adericel-mark-mono-light.svg',
      content: markSvg({ fill: C.paper, treatment: 'solid', idSuffix: 'mml' }),
    },

    { file: 'favicon/favicon.svg', content: faviconSvg(C.ink) },

    { file: 'app/app-icon.svg', content: appIconSvg(C.ink, C.paper) },
  ];
}

/** v1.2 §27 — PNG is an export, never the source of truth. */
interface Raster {
  readonly file: string;
  readonly svg: string;
  readonly width: number;
}

function rasterExports(): Raster[] {
  return [
    { file: 'favicon/favicon-16.png', svg: faviconSvg(C.ink), width: 16 },
    { file: 'favicon/favicon-32.png', svg: faviconSvg(C.ink), width: 32 },
    { file: 'favicon/favicon-48.png', svg: faviconSvg(C.ink), width: 48 },
    { file: 'app/app-icon-light-1024.png', svg: appIconSvg(C.paper, C.ink), width: 1024 },
    { file: 'app/app-icon-dark-1024.png', svg: appIconSvg(C.ink, C.paper), width: 1024 },
  ];
}

function manifest(assetHashes: readonly { file: string; sha256: string }[]): string {
  return `# Adericel brand source manifest — Brand Pack v1.2 §26.
#
# Generated by scripts/build-brand-assets.ts. Do not edit by hand.
brand_version: '1.2'

# PROVISIONAL until the official vector master is supplied. Per §29 this
# geometry must not be described as official, final, canonical or source
# artwork. Replacing it is a geometry substitution, not a redesign (§5).
geometry_source: 'reconstructed-from-raster-brand-sheet-v1.1'
geometry_status: 'provisional'

brand_colours:
  ink: '${C.ink}'
  paper: '${C.paper}'
  slate: '${C.slate}'
state_colours:
  proven: '${C.proven}'
  failing: '${C.failing}'
  exception: '${C.exception}'
structural:
  rule: '${C.rule}'
typography:
  ui: 'Inter'
  data: 'IBM Plex Mono'
  # §6/§18 — outlined from the Inter SemiBold binary, so a distribution asset
  # carries no external font dependency.
  distribution_wordmark: 'outlined'
unknown:
  semantic: 'insufficient authoritative evidence'
  visual: 'hatch'
favicon:
  geometry: 'simplified-two-bar'
  rationale: 'at 16px the hatch aliases and the three-bar silhouette closes up'

# §28 — the builder is deterministic: identical inputs produce identical output.
assets:
${assetHashes.map((a) => `  - file: '${a.file}'\n    sha256: '${a.sha256}'`).join('\n')}
`;
}

async function writeAssets(base: string, list: readonly Asset[]): Promise<void> {
  for (const asset of list) {
    const target = path.join(base, asset.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, asset.content, 'utf8');
  }
}

async function main(): Promise<void> {
  const brandDir = path.join(ROOT, 'brand');
  const vectors = vectorAssets();
  const rasters = rasterExports();

  // Cleared first so a renamed asset does not linger. BRAND.md is authored, not
  // generated, so the directories are removed individually rather than wholesale.
  for (const dir of ['logo', 'mark', 'favicon', 'app']) {
    await rm(path.join(brandDir, dir), { recursive: true, force: true });
  }

  await writeAssets(brandDir, vectors);

  const hashes: { file: string; sha256: string }[] = vectors.map((asset) => ({
    file: asset.file,
    sha256: createHash('sha256').update(asset.content).digest('hex'),
  }));

  for (const raster of rasters) {
    const png = new Resvg(raster.svg, {
      fitTo: { mode: 'width', value: raster.width },
    })
      .render()
      .asPng();
    const target = path.join(brandDir, raster.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, png);
    hashes.push({ file: raster.file, sha256: createHash('sha256').update(png).digest('hex') });
  }

  // §17 — the structure includes these; a README in each says what belongs there
  // rather than leaving an empty directory git will not track.
  for (const [dir, note] of [
    [
      'social',
      'Social and open-graph assets. Generated from the same master once the\nofficial vector is supplied; nothing is placed here by hand.\n',
    ],
    [
      'fonts',
      'Distribution copies of Inter and IBM Plex Mono, for handing to a designer\nor a printer. The application bundles its own copies via @fontsource and\ndoes not read from here.\n',
    ],
  ] as const) {
    await mkdir(path.join(brandDir, dir), { recursive: true });
    await writeFile(path.join(brandDir, dir, 'README.md'), `# ${dir}\n\n${note}`, 'utf8');
  }

  await writeFile(
    path.join(brandDir, 'brand-source.yml'),
    manifest(hashes.sort((a, b) => a.file.localeCompare(b.file))),
    'utf8',
  );

  // What the application serves. The favicon is the simplified derivative; the
  // in-app mark is the master.
  const publicDir = path.join(ROOT, 'apps/web/public/brand');
  await rm(publicDir, { recursive: true, force: true });
  await writeAssets(publicDir, [
    { file: 'favicon.svg', content: faviconSvg(C.ink) },
    { file: 'app-icon.svg', content: appIconSvg(C.ink, C.paper) },
  ]);

  const files = (await readdir(brandDir, { recursive: true, withFileTypes: true })).filter((e) =>
    e.isFile(),
  );
  console.log(`brand/ — ${files.length} files`);
  console.log(`  ${vectors.length} vectors, ${rasters.length} raster exports`);
  console.log('  geometry_status: provisional (v1.2 §29)');
  console.log(`apps/web/public/brand/ — 2 files`);
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
