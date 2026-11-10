import { describe, expect, it } from 'vitest';
import {
  SyncBridgeHeader,
  SyncBridgeRequestKind,
  createSyncBridgeBuffer,
  getSyncBridgeViews,
  readSyncBridgeRequest,
  readSyncBridgeResponse,
  writeSyncBridgeRequest,
  writeSyncBridgeResponse,
} from './sync-bridge-protocol.js';

describe('synchronous bridge protocol', () => {
  it.each([undefined, 0, 1_700_000_000_000, Number.MAX_SAFE_INTEGER])(
    'round-trips response timestamps (%s) without changing payload capacity',
    dateNowMs => {
      const buffer = createSyncBridgeBuffer(128, 128);
      const timing = dateNowMs === undefined ? undefined : { dateNowMs };
      for (const response of [
        { ...timing, payload: '1', sequence: 1, success: true as const },
        {
          ...timing,
          error: { message: 'failed', name: 'Error' },
          sequence: 2,
          success: false as const,
        },
      ]) {
        writeSyncBridgeResponse(buffer, response);
        expect(readSyncBridgeResponse(buffer, response.sequence)).toEqual(
          response,
        );
      }
    },
  );

  it.each([Number.NaN, Infinity, -2, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid response timestamp (%s)',
    dateNowMs => {
      const buffer = createSyncBridgeBuffer(128, 128);
      writeSyncBridgeResponse(buffer, {
        dateNowMs,
        payload: '1',
        sequence: 1,
        success: true,
      });
      expect(() => readSyncBridgeResponse(buffer, 1)).toThrow(
        'Invalid synchronous bridge response header',
      );
    },
  );

  it('round-trips bounded requests and responses', () => {
    const buffer = createSyncBridgeBuffer(128, 128);
    writeSyncBridgeRequest(buffer, {
      kind: SyncBridgeRequestKind.HostFunction,
      name: 'fs.readFile',
      payload: '["/value"]',
      requestIndex: 3,
      sequence: 1,
    });
    expect(readSyncBridgeRequest(buffer)).toEqual({
      kind: SyncBridgeRequestKind.HostFunction,
      name: 'fs.readFile',
      payload: '["/value"]',
      requestIndex: 3,
      sequence: 1,
    });

    writeSyncBridgeResponse(buffer, {
      payload: '"contents"',
      sequence: 1,
      success: true,
    });
    expect(readSyncBridgeResponse(buffer, 1)).toEqual({
      payload: '"contents"',
      sequence: 1,
      success: true,
    });
  });

  it('rejects malformed headers and forged sequence numbers', () => {
    const buffer = createSyncBridgeBuffer(128, 128);
    writeSyncBridgeRequest(buffer, {
      kind: SyncBridgeRequestKind.HostFunction,
      name: 'values.read',
      payload: '[]',
      requestIndex: 1,
      sequence: 1,
    });
    const { header } = getSyncBridgeViews(buffer);
    Atomics.store(header, SyncBridgeHeader.Reserved, 1);
    expect(() => readSyncBridgeRequest(buffer)).toThrow(
      'Invalid synchronous bridge request header',
    );

    writeSyncBridgeResponse(buffer, {
      payload: '1',
      sequence: 2,
      success: true,
    });
    expect(() => readSyncBridgeResponse(buffer, 1)).toThrow(
      'Invalid synchronous bridge response header',
    );
  });

  it('rejects oversized payloads before publishing them', () => {
    const buffer = createSyncBridgeBuffer(1, 1);
    const { bytes } = getSyncBridgeViews(buffer);
    expect(() =>
      writeSyncBridgeRequest(buffer, {
        kind: SyncBridgeRequestKind.HostFunction,
        name: 'values.read',
        payload: 'x'.repeat(bytes.byteLength),
        requestIndex: 1,
        sequence: 1,
      }),
    ).toThrow('exceeds the synchronous bridge capacity');
  });
});
