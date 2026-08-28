import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import * as nodeModule from 'node:module';
import { RunSourceTooLargeError } from '../errors.js';
import type ts from 'typescript';

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
const require = nodeModule.createRequire(import.meta.url);
let typeScriptRuntime: typeof ts | undefined;
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

const extractTransformedFunctionBody = (
  transformed: string,
  wrapperDeclaration: string,
): string | undefined => {
  const declarationStart = transformed.indexOf(wrapperDeclaration);
  if (
    declarationStart === -1 ||
    transformed.slice(0, declarationStart).trim() !== ''
  ) {
    return undefined;
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
    return undefined;
  }
  return transformed
    .slice(bodyStart + 1, bodyEnd)
    .replace(/^\n/u, '')
    .replace(/\n$/u, '');
};

const stripSnippetTypes = (source: string, moduleMode: boolean): string => {
  const { stripTypeScriptTypes } = nodeModule as typeof nodeModule & {
    stripTypeScriptTypes?: (source: string) => string;
  };
  if (stripTypeScriptTypes !== undefined) {
    if (moduleMode) {
      try {
        return stripTypeScriptTypes(source);
      } catch {
        return source;
      }
    }
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
    try {
      typeScriptRuntime ??= require('typescript') as typeof ts;
    } catch {
      // TypeScript is an optional Node 20 fallback. Without it, QuickJS reports
      // unsupported syntax using guest coordinates rather than exposing a host
      // module-resolution failure.
      return source;
    }
    const wrapperDeclaration = 'async function __runUser__()';
    const input = moduleMode ? source : `${wrapperDeclaration}{\n${source}\n}`;
    try {
      const transformed = typeScriptRuntime.transpileModule(input, {
        compilerOptions: {
          isolatedModules: true,
          module: typeScriptRuntime.ModuleKind.ESNext,
          target: typeScriptRuntime.ScriptTarget.ES2023,
          verbatimModuleSyntax: true,
        },
      }).outputText;
      if (moduleMode) {
        return transformed;
      }
      return (
        extractTransformedFunctionBody(transformed, wrapperDeclaration) ??
        source
      );
    } catch {
      return source;
    }
  }
  try {
    if (moduleMode) {
      return bunTypeScriptTranspiler.transformSync(source);
    }
    const wrapperDeclaration = 'async function __runUser__()';
    const transformed = bunTypeScriptTranspiler.transformSync(
      `${wrapperDeclaration}{\n${source}\n}`,
    );
    return (
      extractTransformedFunctionBody(transformed, wrapperDeclaration) ?? source
    );
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

export const transformSource = (source: string, moduleMode = false): string => {
  const hash = createHash('sha256')
    .update(moduleMode ? 'strip-module:' : 'strip:')
    .update(source)
    .digest('hex');
  const cached = transformedSourceCache.get(hash);
  if (cached !== undefined) {
    transformedSourceCache.delete(hash);
    transformedSourceCache.set(hash, cached);
    return cached.source;
  }

  const transformed = stripSnippetTypes(source, moduleMode);
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
