import { once } from 'node:events';
import { RunBindingError } from './errors.js';
import { runWithBindingContext } from './binding-context.js';
import { isBindingInterruptSignal } from './interrupt.js';
import type { BindingContext, Bindings } from './types.js';
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
  const bytes = new TextEncoder().encode(value).byteLength;
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
  bindings: Bindings,
  bindingName: string,
): RunBindingError =>
  new RunBindingError(`Unknown binding: ${bindingName}`, {
    availableBindings: Object.entries(bindings).flatMap(([group, entries]) =>
      Object.keys(entries).map(name => `${group}.${name}`),
    ),
    bindingName,
  });

const resolveBinding = (
  bindings: Bindings,
  bindingName: string,
): InvokableBinding => {
  const separator = bindingName.indexOf('.');
  if (separator <= 0 || separator === bindingName.length - 1) {
    throw unknownBindingError(bindings, bindingName);
  }

  const groupName = bindingName.slice(0, separator);
  const functionName = bindingName.slice(separator + 1);
  if (!Object.hasOwn(bindings, groupName)) {
    throw unknownBindingError(bindings, bindingName);
  }

  const group = bindings[groupName];
  if (
    typeof group !== 'object' ||
    group === null ||
    !Object.hasOwn(group, functionName)
  ) {
    throw unknownBindingError(bindings, bindingName);
  }

  const binding = group[functionName];
  if (typeof binding !== 'function') {
    throw unknownBindingError(bindings, bindingName);
  }

  return binding as InvokableBinding;
};

export const invokeHostBinding = async ({
  bindingName,
  inputJson,
  bindings,
  context,
  maxBindingInputBytes,
  maxBindingOutputBytes,
}: {
  bindingName: string;
  inputJson: string;
  bindings: Bindings;
  context: BindingContext;
  maxBindingInputBytes: number;
  maxBindingOutputBytes: number;
}): Promise<BindingInvocationOutcome> => {
  throwIfAborted(context.abortSignal);

  const binding = resolveBinding(bindings, bindingName);
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
    const output = await runWithBindingContext(
      context,
      async () =>
        await raceAgainstAbort(
          Promise.resolve().then(() => binding(...args)),
          context.abortSignal,
        ),
    );
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
