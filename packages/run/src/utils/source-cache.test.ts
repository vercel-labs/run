import { beforeEach, describe, expect, it } from 'vitest';
import { RunSourceTooLargeError } from '../errors.js';
import {
  assertSourceSize,
  clearTransformedSourceCache,
  getTransformedSourceCacheStats,
  transformSource,
} from './source-cache.js';

describe('source limits and transform cache', () => {
  beforeEach(() => {
    clearTransformedSourceCache();
  });

  it('rejects oversized source before type stripping', () => {
    expect(() => assertSourceSize('const value = 1; return value;', 8)).toThrow(
      RunSourceTooLargeError,
    );
  });

  it('allows source exactly at the byte limit', () => {
    const source = 'return 1;';
    const maxSourceBytes = new TextEncoder().encode(source).byteLength;
    expect(() => assertSourceSize(source, maxSourceBytes)).not.toThrow();
  });

  it('strips TypeScript syntax without changing source line count', () => {
    const source = 'const value: number = 1;\nreturn value;';
    const transformed = transformSource(source);
    expect(transformed).not.toContain(': number');
    expect(transformed.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('does not extract Bun transforms that inject external helpers', () => {
    if ((globalThis as { Bun?: unknown }).Bun === undefined) {
      return;
    }

    const source =
      'using resource: Disposable = getResource();\nreturn resource;';
    expect(transformSource(source)).toBe(source);
  });

  it('does not cache transformed sources above the per-entry byte limit', () => {
    const largeSource = `const value = ${JSON.stringify('x'.repeat(70_000))}; return value.length;`;
    transformSource(largeSource);
    expect(getTransformedSourceCacheStats().entries).toBe(0);
  });

  it('evicts transformed source cache entries by total byte size', () => {
    for (let index = 0; index < 90; index += 1) {
      transformSource(
        `const value = ${JSON.stringify(`${index}:${'x'.repeat(60_000)}`)}; return value.length;`,
      );
    }

    const stats = getTransformedSourceCacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
    expect(stats.entries).toBeLessThan(90);
  });
});
