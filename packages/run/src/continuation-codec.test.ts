import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSignedContinuationCodec,
  createStoredContinuationCodec,
} from './continuation-codec.js';
import type {
  ContinuationStorage,
  StoredContinuation,
} from './continuation-codec.js';
import type { RunContinuationState } from './types.js';
import { createPromiseWithResolvers } from './utils/promise-with-resolvers.js';

const state: RunContinuationState = {
  determinism: {
    dateNowMs: 1_700_000_000_000,
    randomSeed: '01'.repeat(16),
  },
  ledger: [
    {
      bindingName: 'tools.pause',
      inputJson: '[[]]',
      interruptionId: 'interrupt-1',
      payloadJson: '[{"kind":1},"approval"]',
      status: 'interrupted',
    },
  ],
  logicalRunId: '03'.repeat(16),
  runtime: 'run-replay-v2',
  scopeHash: '02'.repeat(32),
  serde: 'run-js-v1',
  source: 'return await tools.pause();',
  version: 2,
};

const tokenBody = (token: string): string => {
  const [body] = token.split('.');
  if (body === undefined) {
    throw new Error('Expected a signed continuation body.');
  }
  return body;
};

const createMemoryStorage = (): {
  storage: ContinuationStorage;
  values: Map<string, StoredContinuation>;
} => {
  const values = new Map<string, StoredContinuation>();
  const leases = new Map<string, string>();
  return {
    storage: {
      acquire(key, leaseId) {
        if (leases.has(key)) {
          return undefined;
        }
        const value = values.get(key);
        if (value !== undefined) {
          leases.set(key, leaseId);
        }
        return value;
      },
      consume(key, leaseId) {
        if (leases.get(key) === leaseId) {
          leases.delete(key);
          values.delete(key);
        }
      },
      release(key, leaseId) {
        if (leases.get(key) === leaseId) {
          leases.delete(key);
        }
      },
      set(key, value) {
        values.set(key, value);
      },
    },
    values,
  };
};

afterEach(() => vi.useRealTimers());

describe('continuation codecs', () => {
  it('atomically consumes stored continuations', async () => {
    const { storage } = createMemoryStorage();
    const codec = createStoredContinuationCodec({
      storage,
    });
    const token = await codec.encode(state);
    await expect(codec.decode(token)).resolves.toEqual(state);
    await expect(codec.decode(token)).rejects.toMatchObject({
      code: 'RUN_PROTOCOL_ERROR',
    });
  });

  it('allows exactly one of many concurrent stored continuation consumers', async () => {
    const { storage } = createMemoryStorage();
    const codec = createStoredContinuationCodec({
      storage,
    });
    const token = await codec.encode(state);
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, () => codec.decode(token)),
    );
    expect(
      results.filter(result => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(
      31,
    );
  });

  it('releases a stored continuation when acquire finishes after an abort', async () => {
    const values = new Map<string, StoredContinuation>();
    const leases = new Map<string, string>();
    const acquireStarted = createPromiseWithResolvers<null>();
    const finishAcquire = createPromiseWithResolvers<null>();
    const codec = createStoredContinuationCodec({
      storage: {
        async acquire(key, leaseId) {
          if (leases.has(key)) {
            return undefined;
          }
          const value = values.get(key);
          if (value !== undefined) {
            leases.set(key, leaseId);
          }
          acquireStarted.resolve(null);
          await finishAcquire.promise;
          return value;
        },
        consume(key, leaseId) {
          if (leases.get(key) === leaseId) {
            leases.delete(key);
            values.delete(key);
          }
        },
        release(key, leaseId) {
          if (leases.get(key) === leaseId) {
            leases.delete(key);
          }
        },
        set(key, value) {
          values.set(key, value);
        },
      },
    });
    const token = await codec.encode(state);
    const abortController = new AbortController();
    const decode = codec.decode(token, {
      abortSignal: abortController.signal,
      deadlineMs: Date.now() + 1000,
    });

    await acquireStarted.promise;
    abortController.abort();
    finishAcquire.resolve(null);

    await expect(decode).rejects.toMatchObject({ name: 'AbortError' });
    await expect(codec.decode(token)).resolves.toEqual(state);
  });

  it('enforces stored continuation expiry itself', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { storage } = createMemoryStorage();
    const codec = createStoredContinuationCodec({
      maxAgeMs: 10,
      storage,
    });
    const token = await codec.encode(state);
    vi.setSystemTime(1011);
    await expect(codec.decode(token)).rejects.toThrow('expired');
  });

  it('bounds signed tokens before returning or verifying them', () => {
    const codec = createSignedContinuationCodec({
      maxTokenBytes: 32,
      secret: 's'.repeat(32),
    });
    expect(() => codec.encode(state)).toThrow('size limit');
    expect(() => codec.decode('x'.repeat(33))).toThrow('size limit');
  });

  it('requires strong signing keys and validates key-rotation options', () => {
    expect(() =>
      createSignedContinuationCodec({ secret: 'too-short' }),
    ).toThrow('at least 32 bytes');
    expect(() =>
      createSignedContinuationCodec({
        secret: 's'.repeat(32),
        verificationSecrets: ['old-short'],
      }),
    ).toThrow('at least 32 bytes');
    expect(() =>
      createSignedContinuationCodec({
        clockSkewMs: -1,
        secret: 's'.repeat(32),
      }),
    ).toThrow('non-negative integer');
  });

  it('supports verification-only previous secrets during key rotation', () => {
    const oldSecret = 'o'.repeat(32);
    const newSecret = 'n'.repeat(32);
    const oldCodec = createSignedContinuationCodec({ secret: oldSecret });
    const rotatedCodec = createSignedContinuationCodec({
      secret: newSecret,
      verificationSecrets: [oldSecret],
    });
    const oldToken = oldCodec.encode(state) as string;
    expect(rotatedCodec.decode(oldToken)).toEqual(state);

    const newToken = rotatedCodec.encode(state) as string;
    expect(() => oldCodec.decode(newToken)).toThrow('signature');
  });

  it('expires at the exact boundary and rejects future-issued tokens', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const codec = createSignedContinuationCodec({
      clockSkewMs: 0,
      maxAgeMs: 10,
      secret: 's'.repeat(32),
    });
    const token = codec.encode(state) as string;
    vi.setSystemTime(1010);
    expect(() => codec.decode(token)).toThrow('expired');

    vi.setSystemTime(2000);
    const futureToken = codec.encode(state) as string;
    vi.setSystemTime(1999);
    expect(() => codec.decode(futureToken)).toThrow('future');
  });

  it.each([
    ['format', 'other'],
    ['version', 2],
    ['algorithm', 'none'],
    ['nonce', 'bad'],
  ])('rejects authenticated envelope confusion in %s', (field, value) => {
    const secret = 's'.repeat(32);
    const codec = createSignedContinuationCodec({ secret });
    const token = codec.encode(state) as string;
    const body = tokenBody(token);
    const envelope = JSON.parse(
      Buffer.from(body, 'base64url').toString(),
    ) as Record<string, unknown>;
    envelope[field] = value;
    const changedBody = Buffer.from(JSON.stringify(envelope)).toString(
      'base64url',
    );
    const signature = createHmac('sha256', secret)
      .update('run.continuation.v1\0')
      .update(changedBody)
      .digest('base64url');
    expect(() => codec.decode(`${changedBody}.${signature}`)).toThrow(
      /envelope|canonical|lifetime/i,
    );
  });

  it('rejects authenticated unknown envelope fields and non-canonical JSON', () => {
    const secret = 's'.repeat(32);
    const codec = createSignedContinuationCodec({ secret });
    const token = codec.encode(state) as string;
    const body = tokenBody(token);
    const envelope = JSON.parse(
      Buffer.from(body, 'base64url').toString(),
    ) as Record<string, unknown>;
    envelope.extra = true;
    const changedBody = Buffer.from(JSON.stringify(envelope)).toString(
      'base64url',
    );
    const signature = createHmac('sha256', secret)
      .update('run.continuation.v1\0')
      .update(changedBody)
      .digest('base64url');
    expect(() => codec.decode(`${changedBody}.${signature}`)).toThrow(
      /envelope|canonical/i,
    );
  });

  it('rejects bit changes, truncation, extension, wrong keys, and invalid base64', () => {
    const codec = createSignedContinuationCodec({ secret: 's'.repeat(32) });
    const wrong = createSignedContinuationCodec({ secret: 'w'.repeat(32) });
    const token = codec.encode(state) as string;
    const mutations = [
      token.slice(0, -1),
      `${token}x`,
      `!${token.slice(1)}`,
      `${token.split('.')[0]}.=`,
      `${token.slice(0, 10)}${token[10] === 'A' ? 'B' : 'A'}${token.slice(11)}`,
    ];
    for (const mutation of mutations) {
      expect(() => codec.decode(mutation)).toThrow();
    }
    expect(() => wrong.decode(token)).toThrow('signature');
  });

  it('fails closed for 1,000 deterministic signed-token mutations', () => {
    const codec = createSignedContinuationCodec({ secret: 's'.repeat(32) });
    const token = codec.encode(state) as string;
    let random = 1_831_565_813;
    const next = (): number => {
      random = (random * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return random;
    };
    for (let iteration = 0; iteration < 1000; iteration += 1) {
      const index = next() % token.length;
      const replacement = String.fromCodePoint(33 + (next() % 90));
      const mutation = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
      if (mutation !== token) {
        expect(() => codec.decode(mutation)).toThrowError(
          expect.objectContaining({ code: 'RUN_PROTOCOL_ERROR' }),
        );
      }
    }
  });

  it.each([
    '',
    'x',
    'a'.repeat(42),
    'a'.repeat(44),
    'a'.repeat(257),
    'bad!key',
  ])('rejects malformed stored key %j before storage access', async key => {
    const acquire = vi.fn();
    const codec = createStoredContinuationCodec({
      storage: {
        acquire,
        consume: () => {},
        release: () => {},
        set: () => {},
      },
    });
    await expect(codec.decode(key)).rejects.toMatchObject({
      code: 'RUN_PROTOCOL_ERROR',
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('does not issue a stored key before persistence succeeds', async () => {
    const codec = createStoredContinuationCodec({
      storage: {
        acquire() {
          throw new Error('not used');
        },
        consume() {
          throw new Error('not used');
        },
        release() {
          throw new Error('not used');
        },
        set() {
          throw new Error('storage unavailable');
        },
      },
    });
    await expect(codec.encode(state)).rejects.toThrow('storage unavailable');
  });
});
