import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { RunBindingError } from './errors.js';
import { runWithBindingContext } from './binding-context.js';
import { isBindingInterruptSignal } from './interrupt.js';
import type { BindingContext, BindingManifest, Bindings } from './types.js';
import { parseJsonPayload, toJsonPayload } from './utils/serialization.js';

export type BindingInvocationOutcome =
  | { status: 'fulfilled'; valueJson: string }
  | { status: 'interrupted'; payloadJson: string };

type InvokableBinding = (...args: unknown[]) => unknown | Promise<unknown>;

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
    throw new RunBindingError(
      `${label} exceeds the ${maxBytes} byte size limit.`,
      {
        bytes,
        maxBytes,
      },
    );
  }
};

const unknownBindingError = (
  bindingManifest: BindingManifest,
  bindingName: string,
): RunBindingError =>
  new RunBindingError(`Unknown binding: ${bindingName}`, {
    availableBindings: [...bindingManifest.entries()].flatMap(
      ([group, names]) => [...names].map(name => `${group}.${name}`),
    ),
    bindingName,
  });

const resolveBinding = (
  bindings: Bindings,
  bindingManifest: BindingManifest,
  bindingName: string,
): InvokableBinding => {
  const separator = bindingName.indexOf('.');
  if (separator <= 0 || separator === bindingName.length - 1) {
    throw unknownBindingError(bindingManifest, bindingName);
  }

  const groupName = bindingName.slice(0, separator);
  const functionName = bindingName.slice(separator + 1);
  if (bindingManifest.get(groupName)?.has(functionName) !== true) {
    throw unknownBindingError(bindingManifest, bindingName);
  }

  const groupDescriptor = Object.getOwnPropertyDescriptor(bindings, groupName);
  if (
    groupDescriptor?.enumerable !== true ||
    !Object.hasOwn(groupDescriptor, 'value')
  ) {
    throw unknownBindingError(bindingManifest, bindingName);
  }

  const group = groupDescriptor.value as unknown;
  if (typeof group !== 'object' || group === null) {
    throw unknownBindingError(bindingManifest, bindingName);
  }

  const bindingDescriptor = Object.getOwnPropertyDescriptor(
    group,
    functionName,
  );
  if (
    bindingDescriptor?.enumerable !== true ||
    !Object.hasOwn(bindingDescriptor, 'value')
  ) {
    throw unknownBindingError(bindingManifest, bindingName);
  }

  const binding = bindingDescriptor.value;
  if (typeof binding !== 'function') {
    throw unknownBindingError(bindingManifest, bindingName);
  }

  return binding as InvokableBinding;
};

export const invokeHostBinding = async ({
  bindingName,
  inputJson,
  bindingManifest,
  bindings,
  context,
  maxBindingInputBytes,
  maxBindingOutputBytes,
}: {
  bindingName: string;
  inputJson: string;
  bindingManifest: BindingManifest;
  bindings: Bindings;
  context: BindingContext;
  maxBindingInputBytes: number;
  maxBindingOutputBytes: number;
}): Promise<BindingInvocationOutcome> => {
  throwIfAborted(context.abortSignal);

  const binding = resolveBinding(bindings, bindingManifest, bindingName);
  assertPayloadSize(inputJson, maxBindingInputBytes, 'Binding arguments');
  const args = parseJsonPayload(
    inputJson,
    `Binding "${bindingName}" arguments`,
  );
  if (!Array.isArray(args)) {
    throw new RunBindingError(
      `Binding "${bindingName}" arguments must be encoded as an array.`,
      { bindingName },
    );
  }

  try {
    const operation = runWithBindingContext(context, () => binding(...args));
    const output = await raceAgainstAbort(operation, context.abortSignal);
    return {
      status: 'fulfilled',
      valueJson: toJsonPayload(
        output,
        maxBindingOutputBytes,
        `Binding "${bindingName}" output`,
      ),
    };
  } catch (error) {
    if (isBindingInterruptSignal(error)) {
      const payloadJson = toJsonPayload(
        error.payload,
        maxBindingOutputBytes,
        `Binding "${bindingName}" interruption payload`,
      );
      return {
        payloadJson,
        status: 'interrupted',
      };
    }
    throw error;
  }
};
