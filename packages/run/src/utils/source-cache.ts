import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import * as nodeModule from 'node:module';
import { RunSourceTooLargeError } from '../errors.js';

const MAX_CACHE_ENTRIES = 256;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRY_BYTES = 64 * 1024;
const bunRuntime = (
  globalThis as typeof globalThis & {
    Bun?: {
      Transpiler: new (options: { loader: 'ts' }) => {
        transformSync: (source: string) => string;
      };
    };
  }
).Bun;
const bunTypeScriptTranspiler =
  bunRuntime === undefined
    ? undefined
    : new bunRuntime.Transpiler({ loader: 'ts' });
const transformedSourceCache = new Map<
  string,
  {
    source: string;
    bytes: number;
  }
>();
let transformedSourceCacheBytes = 0;

const byteLength = (value: string): number => Buffer.byteLength(value);

const evictTransformedSourceCache = (): void => {
  while (
    transformedSourceCache.size > MAX_CACHE_ENTRIES ||
    transformedSourceCacheBytes > MAX_CACHE_BYTES
  ) {
    const oldest = transformedSourceCache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    const entry = transformedSourceCache.get(oldest);
    transformedSourceCache.delete(oldest);
    transformedSourceCacheBytes -= entry?.bytes ?? 0;
  }
};

const stripSnippetTypes = (source: string): string => {
  const { stripTypeScriptTypes } = nodeModule as typeof nodeModule & {
    stripTypeScriptTypes?: (source: string) => string;
  };
  if (stripTypeScriptTypes !== undefined) {
    const prefix = 'async function __runUser__(){\n';
    const suffix = '\n}';
    let stripped: string;
    try {
      stripped = stripTypeScriptTypes(`${prefix}${source}${suffix}`);
    } catch {
      // Let QuickJS report syntax failures. Its diagnostics use the same source
      // filename and coordinates as runtime failures and do not expose the host
      // TypeScript transform or its wrapper.
      return source;
    }
    if (!stripped.startsWith(prefix) || !stripped.endsWith(suffix)) {
      return source;
    }
    return stripped.slice(prefix.length, -suffix.length);
  }

  if (bunTypeScriptTranspiler === undefined) {
    return source;
  }
  try {
    const wrapperDeclaration = 'async function __runUser__()';
    const transformed = bunTypeScriptTranspiler.transformSync(
      `${wrapperDeclaration}{\n${source}\n}`,
    );
    const declarationStart = transformed.indexOf(wrapperDeclaration);
    if (
      declarationStart === -1 ||
      transformed.slice(0, declarationStart).trim() !== ''
    ) {
      return source;
    }
    const bodyStart = transformed.indexOf(
      '{',
      declarationStart + wrapperDeclaration.length,
    );
    const bodyEnd = transformed.lastIndexOf('}');
    if (
      bodyStart === -1 ||
      bodyEnd <= bodyStart ||
      transformed.slice(bodyEnd + 1).trim() !== ''
    ) {
      return source;
    }
    return transformed
      .slice(bodyStart + 1, bodyEnd)
      .replace(/^\n/u, '')
      .replace(/\n$/u, '');
  } catch {
    return source;
  }
};

export const assertSourceSize = (
  source: string,
  maxSourceBytes: number,
): void => {
  const bytes = byteLength(source);
  if (bytes > maxSourceBytes) {
    throw new RunSourceTooLargeError(bytes, maxSourceBytes);
  }
};

export const transformSource = (source: string): string => {
  const hash = createHash('sha256')
    .update('strip:')
    .update(source)
    .digest('hex');
  const cached = transformedSourceCache.get(hash);
  if (cached !== undefined) {
    transformedSourceCache.delete(hash);
    transformedSourceCache.set(hash, cached);
    return cached.source;
  }

  const transformed = stripSnippetTypes(source);
  const transformedBytes = byteLength(transformed);
  if (transformedBytes <= MAX_CACHE_ENTRY_BYTES) {
    transformedSourceCache.set(hash, {
      bytes: transformedBytes,
      source: transformed,
    });
    transformedSourceCacheBytes += transformedBytes;
    evictTransformedSourceCache();
  }
  return transformed;
};

export const getTransformedSourceCacheStats = () => ({
  bytes: transformedSourceCacheBytes,
  entries: transformedSourceCache.size,
  maxBytes: MAX_CACHE_BYTES,
  maxEntries: MAX_CACHE_ENTRIES,
  maxEntryBytes: MAX_CACHE_ENTRY_BYTES,
});

export const clearTransformedSourceCache = (): void => {
  transformedSourceCache.clear();
  transformedSourceCacheBytes = 0;
};
