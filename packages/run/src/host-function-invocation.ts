import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { RunHostFunctionError } from './errors.js';
import { runWithHostFunctionContext } from './host-function-context.js';
import { isHostFunctionInterruptSignal } from './interrupt.js';
import type {
  HostFunctionContext,
  HostFunctionManifest,
  HostFunctions,
} from './types.js';
import { parseJsonPayload, toJsonPayload } from './utils/serialization.js';

export type HostFunctionInvocationOutcome =
  | { status: 'fulfilled'; valueJson: string }
  | { status: 'interrupted'; payloadJson: string };

type InvokableHostFunction = (...args: unknown[]) => unknown | Promise<unknown>;

const abortReason = (abortSignal: AbortSignal): unknown =>
  abortSignal.reason ??
  new DOMException('The operation was aborted.', 'AbortError');

const throwIfAborted = (abortSignal: AbortSignal): void => {
  if (abortSignal.aborted) {
    throw abortReason(abortSignal);
  }
};

const raceAgainstAbort = async <T>(
  operation: Promise<T>,
  abortSignal: AbortSignal,
): Promise<T> => {
  throwIfAborted(abortSignal);
  const listenerController = new AbortController();
  const aborted = (async (): Promise<never> => {
    await once(abortSignal, 'abort', {
      signal: listenerController.signal,
    });
    throw abortReason(abortSignal);
  })();
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    listenerController.abort();
  }
};

const assertPayloadSize = (
  value: string,
  maxBytes: number,
  label: string,
): void => {
  const bytes = Buffer.byteLength(value);
  if (bytes > maxBytes) {
    throw new RunHostFunctionError(
      `${label} exceeds the ${maxBytes} byte size limit.`,
      {
        bytes,
        maxBytes,
      },
    );
  }
};

const unknownHostFunctionError = (
  hostFunctionManifest: HostFunctionManifest,
  hostFunctionName: string,
): RunHostFunctionError =>
  new RunHostFunctionError(`Unknown host function: ${hostFunctionName}`, {
    availableHostFunctions: [...hostFunctionManifest.entries()].flatMap(
      ([group, names]) => [...names].map(name => `${group}.${name}`),
    ),
    hostFunctionName,
  });

const resolveHostFunction = (
  hostFunctions: HostFunctions,
  hostFunctionManifest: HostFunctionManifest,
  hostFunctionName: string,
): InvokableHostFunction => {
  const separator = hostFunctionName.indexOf('.');
  if (separator <= 0 || separator === hostFunctionName.length - 1) {
    throw unknownHostFunctionError(hostFunctionManifest, hostFunctionName);
  }

  const groupName = hostFunctionName.slice(0, separator);
  const functionName = hostFunctionName.slice(separator + 1);
  if (hostFunctionManifest.get(groupName)?.has(functionName) !== true) {
    throw unknownHostFunctionError(hostFunctionManifest, hostFunctionName);
  }

  const groupDescriptor = Object.getOwnPropertyDescriptor(
    hostFunctions,
    groupName,
  );
  if (
    groupDescriptor?.enumerable !== true ||
    !Object.hasOwn(groupDescriptor, 'value')
  ) {
    throw unknownHostFunctionError(hostFunctionManifest, hostFunctionName);
  }

  const group = groupDescriptor.value as unknown;
  if (typeof group !== 'object' || group === null) {
    throw unknownHostFunctionError(hostFunctionManifest, hostFunctionName);
  }

  const functionDescriptor = Object.getOwnPropertyDescriptor(
    group,
    functionName,
  );
  if (
    functionDescriptor?.enumerable !== true ||
    !Object.hasOwn(functionDescriptor, 'value')
  ) {
    throw unknownHostFunctionError(hostFunctionManifest, hostFunctionName);
  }

  const hostFunction = functionDescriptor.value;
  if (typeof hostFunction !== 'function') {
    throw unknownHostFunctionError(hostFunctionManifest, hostFunctionName);
  }

  return hostFunction as InvokableHostFunction;
};

export const invokeHostFunction = async ({
  hostFunctionName,
  inputJson,
  hostFunctionManifest,
  hostFunctions,
  context,
  maxHostFunctionInputBytes,
  maxHostFunctionOutputBytes,
}: {
  hostFunctionName: string;
  inputJson: string;
  hostFunctionManifest: HostFunctionManifest;
  hostFunctions: HostFunctions;
  context: HostFunctionContext;
  maxHostFunctionInputBytes: number;
  maxHostFunctionOutputBytes: number;
}): Promise<HostFunctionInvocationOutcome> => {
  throwIfAborted(context.abortSignal);

  const hostFunction = resolveHostFunction(
    hostFunctions,
    hostFunctionManifest,
    hostFunctionName,
  );
  assertPayloadSize(
    inputJson,
    maxHostFunctionInputBytes,
    'Host function arguments',
  );
  const args = parseJsonPayload(
    inputJson,
    `Host function "${hostFunctionName}" arguments`,
  );
  if (!Array.isArray(args)) {
    throw new RunHostFunctionError(
      `Host function "${hostFunctionName}" arguments must be encoded as an array.`,
      { hostFunctionName },
    );
  }

  try {
    const operation = runWithHostFunctionContext(context, () =>
      hostFunction(...args),
    );
    const output = await raceAgainstAbort(operation, context.abortSignal);
    return {
      status: 'fulfilled',
      valueJson: toJsonPayload(
        output,
        maxHostFunctionOutputBytes,
        `Host function "${hostFunctionName}" output`,
      ),
    };
  } catch (error) {
    if (isHostFunctionInterruptSignal(error)) {
      const payloadJson = toJsonPayload(
        error.payload,
        maxHostFunctionOutputBytes,
        `Host function "${hostFunctionName}" interruption payload`,
      );
      return {
        payloadJson,
        status: 'interrupted',
      };
    }
    throw error;
  }
};
