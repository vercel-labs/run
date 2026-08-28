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
