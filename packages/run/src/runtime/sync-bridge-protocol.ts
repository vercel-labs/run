import { Buffer } from 'node:buffer';
import type { SerializableError } from '../types.js';

export const SYNC_BRIDGE_HEADER_INTS = 8;
export const SYNC_BRIDGE_HEADER_BYTES =
  SYNC_BRIDGE_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
export const MAX_SYNC_BRIDGE_BUFFER_BYTES = 64 * 1024 * 1024;

export enum SyncBridgeState {
  Idle = 0,
  Request = 1,
  Response = 2,
  Closed = 3,
}

export enum SyncBridgeRequestKind {
  HostFunction = 1,
  ModuleNormalize = 2,
  ModuleLoad = 3,
}

export enum SyncBridgeHeader {
  State = 0,
  Sequence = 1,
  Kind = 2,
  NameBytes = 3,
  PayloadBytes = 4,
  Success = 5,
  RequestIndex = 6,
  Reserved = 7,
}

export interface SyncBridgeRequest {
  sequence: number;
  requestIndex: number;
  kind: SyncBridgeRequestKind;
  name: string;
  payload: string;
}

export type SyncBridgeResponse =
  | { sequence: number; success: true; payload: string }
  | {
      sequence: number;
      success: false;
      error: SerializableError;
    };

const decoder = new TextDecoder('utf-8', { fatal: true });

export const getSyncBridgeBufferBytes = (
  maxInputBytes: number,
  maxOutputBytes: number,
): number =>
  SYNC_BRIDGE_HEADER_BYTES +
  Math.max(1024 + maxInputBytes, maxOutputBytes, 64 * 1024);

export const createSyncBridgeBuffer = (
  maxInputBytes: number,
  maxOutputBytes: number,
): SharedArrayBuffer =>
  new SharedArrayBuffer(
    getSyncBridgeBufferBytes(maxInputBytes, maxOutputBytes),
  );

export const getSyncBridgeViews = (buffer: SharedArrayBuffer) => ({
  bytes: new Uint8Array(buffer, SYNC_BRIDGE_HEADER_BYTES),
  header: new Int32Array(buffer, 0, SYNC_BRIDGE_HEADER_INTS),
});

const encodeUtf8 = (value: string): Uint8Array => Buffer.from(value, 'utf8');

const assertWritableBytes = (
  bytes: Uint8Array,
  required: number,
  label: string,
): void => {
  if (
    !Number.isSafeInteger(required) ||
    required < 0 ||
    required > bytes.length
  ) {
    throw new RangeError(`${label} exceeds the synchronous bridge capacity.`);
  }
};

export const writeSyncBridgeRequest = (
  buffer: SharedArrayBuffer,
  request: SyncBridgeRequest,
): void => {
  const { bytes, header } = getSyncBridgeViews(buffer);
  const name = encodeUtf8(request.name);
  const payload = encodeUtf8(request.payload);
  assertWritableBytes(bytes, name.byteLength + payload.byteLength, 'Request');
  bytes.set(name, 0);
  bytes.set(payload, name.byteLength);
  Atomics.store(header, SyncBridgeHeader.Sequence, request.sequence);
  Atomics.store(header, SyncBridgeHeader.Kind, request.kind);
  Atomics.store(header, SyncBridgeHeader.NameBytes, name.byteLength);
  Atomics.store(header, SyncBridgeHeader.PayloadBytes, payload.byteLength);
  Atomics.store(header, SyncBridgeHeader.Success, 0);
  Atomics.store(header, SyncBridgeHeader.RequestIndex, request.requestIndex);
  Atomics.store(header, SyncBridgeHeader.Reserved, 0);
};

export const readSyncBridgeRequest = (
  buffer: SharedArrayBuffer,
): SyncBridgeRequest => {
  const { bytes, header } = getSyncBridgeViews(buffer);
  const sequence = Atomics.load(header, SyncBridgeHeader.Sequence);
  const kind = Atomics.load(header, SyncBridgeHeader.Kind);
  const nameBytes = Atomics.load(header, SyncBridgeHeader.NameBytes);
  const payloadBytes = Atomics.load(header, SyncBridgeHeader.PayloadBytes);
  const requestIndex = Atomics.load(header, SyncBridgeHeader.RequestIndex);
  if (
    !Number.isSafeInteger(sequence) ||
    sequence <= 0 ||
    (kind !== SyncBridgeRequestKind.HostFunction &&
      kind !== SyncBridgeRequestKind.ModuleNormalize &&
      kind !== SyncBridgeRequestKind.ModuleLoad) ||
    nameBytes < 0 ||
    payloadBytes < 0 ||
    !Number.isSafeInteger(requestIndex) ||
    requestIndex <= 0 ||
    nameBytes + payloadBytes > bytes.length ||
    Atomics.load(header, SyncBridgeHeader.Success) !== 0 ||
    Atomics.load(header, SyncBridgeHeader.Reserved) !== 0
  ) {
    throw new TypeError('Invalid synchronous bridge request header.');
  }
  return {
    kind: kind as SyncBridgeRequestKind,
    name: decoder.decode(bytes.subarray(0, nameBytes)),
    payload: decoder.decode(
      bytes.subarray(nameBytes, nameBytes + payloadBytes),
    ),
    requestIndex,
    sequence,
  };
};

export const writeSyncBridgeResponse = (
  buffer: SharedArrayBuffer,
  response: SyncBridgeResponse,
): void => {
  const { bytes, header } = getSyncBridgeViews(buffer);
  const encoded = encodeUtf8(
    response.success ? response.payload : JSON.stringify(response.error),
  );
  assertWritableBytes(bytes, encoded.byteLength, 'Response');
  bytes.set(encoded, 0);
  Atomics.store(header, SyncBridgeHeader.Sequence, response.sequence);
  Atomics.store(header, SyncBridgeHeader.Kind, 0);
  Atomics.store(header, SyncBridgeHeader.NameBytes, 0);
  Atomics.store(header, SyncBridgeHeader.PayloadBytes, encoded.byteLength);
  Atomics.store(header, SyncBridgeHeader.Success, response.success ? 1 : 0);
  Atomics.store(header, SyncBridgeHeader.RequestIndex, 0);
  Atomics.store(header, SyncBridgeHeader.Reserved, 0);
};

export const readSyncBridgeResponse = (
  buffer: SharedArrayBuffer,
  expectedSequence: number,
): SyncBridgeResponse => {
  const { bytes, header } = getSyncBridgeViews(buffer);
  const sequence = Atomics.load(header, SyncBridgeHeader.Sequence);
  const payloadBytes = Atomics.load(header, SyncBridgeHeader.PayloadBytes);
  const success = Atomics.load(header, SyncBridgeHeader.Success);
  if (
    sequence !== expectedSequence ||
    Atomics.load(header, SyncBridgeHeader.Kind) !== 0 ||
    Atomics.load(header, SyncBridgeHeader.NameBytes) !== 0 ||
    payloadBytes <= 0 ||
    payloadBytes > bytes.length ||
    (success !== 0 && success !== 1) ||
    Atomics.load(header, SyncBridgeHeader.RequestIndex) !== 0 ||
    Atomics.load(header, SyncBridgeHeader.Reserved) !== 0
  ) {
    throw new TypeError('Invalid synchronous bridge response header.');
  }
  const payload = decoder.decode(bytes.subarray(0, payloadBytes));
  if (success === 1) {
    return { payload, sequence, success: true };
  }
  const error = JSON.parse(payload) as SerializableError;
  if (
    typeof error !== 'object' ||
    error === null ||
    typeof error.name !== 'string' ||
    typeof error.message !== 'string'
  ) {
    throw new TypeError('Invalid synchronous bridge error response.');
  }
  return { error, sequence, success: false };
};

export const waitAsyncForSyncBridgeChange = async (
  header: Int32Array,
  expectedState: SyncBridgeState,
): Promise<void> => {
  const { waitAsync } = Atomics as typeof Atomics & {
    waitAsync(
      array: Int32Array,
      index: number,
      value: number,
    ): { async: boolean; value: string | Promise<string> };
  };
  const result = waitAsync(header, SyncBridgeHeader.State, expectedState);
  if (result.async) {
    await result.value;
  }
};
