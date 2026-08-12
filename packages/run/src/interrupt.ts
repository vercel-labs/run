import { normalizeJsonPayload } from './utils/serialization.js';

const interruptMarker = Symbol('run.host-function-interrupt');

export interface HostFunctionInterruptSignal extends Error {
  readonly payload: unknown;
  readonly [interruptMarker]: true;
}

export const interrupt = (payload: unknown): never => {
  const normalizedPayload = normalizeJsonPayload(
    payload,
    Number.MAX_SAFE_INTEGER,
    'Interruption payload',
  );
  const error = new Error('Host function interruption requested.');
  error.name = 'HostFunctionInterruptSignal';
  Object.defineProperties(error, {
    [interruptMarker]: { value: true },
    payload: { value: normalizedPayload },
  });
  throw error;
};

export const isHostFunctionInterruptSignal = (
  value: unknown,
): value is HostFunctionInterruptSignal =>
  typeof value === 'object' &&
  value !== null &&
  (value as Partial<HostFunctionInterruptSignal>)[interruptMarker] === true;
