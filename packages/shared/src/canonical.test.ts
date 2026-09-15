import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash, shortHash } from './canonical.js';

describe('canonicalJson', () => {
  it('orders object keys deterministically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('orders nested keys too', () => {
    const one = canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } });
    const two = canonicalJson({ outer: { a: { b: 3, y: 2 }, z: 1 } });
    expect(one).toBe(two);
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('drops undefined properties but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('normalises -0 so it cannot produce two hashes for one value', () => {
    expect(canonicalJson({ v: -0 })).toBe(canonicalJson({ v: 0 }));
  });

  it('rejects non-finite numbers rather than silently emitting null', () => {
    expect(() => canonicalJson({ v: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ v: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  it('serialises dates as ISO strings', () => {
    expect(canonicalJson({ at: new Date('2026-01-02T03:04:05.000Z') })).toBe(
      '{"at":"2026-01-02T03:04:05.000Z"}',
    );
  });

  it('rejects circular references', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/circular/);
  });

  it('allows the same object to appear twice in a tree', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe('contentHash', () => {
  it('is stable across key ordering', () => {
    expect(contentHash({ a: 1, b: [1, 2] })).toBe(contentHash({ b: [1, 2], a: 1 }));
  });

  it('changes when any value changes', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('is algorithm-prefixed', () => {
    expect(contentHash({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces a short form for display', () => {
    expect(shortHash(contentHash({}))).toHaveLength(12);
  });
});
