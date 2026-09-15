import type { Me } from './types.js';

export type SurfaceName = Me['surfaces'][number]['surface'];

/**
 * Which control room this session is in.
 *
 * The three surfaces are separate information boundaries, not three themes.
 * The app never decides who may see what — the API refuses what it refuses —
 * but it must not offer a door that will not open, and it must say plainly
 * which room the person is standing in. Someone who holds authority in more
 * than one is shown the narrowest first, because that is the safer default and
 * the more common case is an operator who forgot which hat they had on.
 */
const NARROWEST_FIRST: readonly SurfaceName[] = [
  'ADERICEL_CLIENT',
  'ADERICEL_MSP',
  'VEYLITH_INTERNAL',
];

export function occupies(me: Me, surface: SurfaceName): boolean {
  return me.surfaces.some((entry) => entry.surface === surface);
}

/** True when this session sees exactly one organisation and nothing above it. */
export function isClientOnly(me: Me): boolean {
  return me.surfaces.length === 1 && me.surfaces[0]?.surface === 'ADERICEL_CLIENT';
}

export function primarySurface(me: Me): SurfaceName | null {
  for (const candidate of NARROWEST_FIRST) {
    if (occupies(me, candidate)) return candidate;
  }
  return null;
}

/**
 * How the surface is named to the person in it.
 *
 * The client's own organisation is named rather than labelled "client", because
 * nobody thinks of themselves as a client of the software they are using.
 */
export function surfaceLabel(me: Me): { product: string; room: string } | null {
  const surface = primarySurface(me);
  if (surface === null) return null;
  if (surface === 'VEYLITH_INTERNAL') {
    return { product: 'Veylith', room: 'Internal control room' };
  }
  if (surface === 'ADERICEL_MSP') {
    return { product: 'Adericel', room: me.msps[0]?.name ?? 'MSP control room' };
  }
  const scopeId = me.surfaces.find((entry) => entry.surface === 'ADERICEL_CLIENT')?.scopeIds[0];
  const organisation = me.organisations.find((org) => org.id === scopeId);
  return { product: 'Adericel', room: organisation?.name ?? 'Your organisation' };
}
