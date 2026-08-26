import { writeSync } from 'node:fs';
import { formatWithOptions } from 'node:util';
import { parentPort } from 'node:worker_threads';
import { JSException, QuickJS } from 'quickjs-wasi';
import type { Deferred, JSValueHandle } from 'quickjs-wasi';
import {
  RunProtocolError,
  RunTimeoutError,
  serializeError,
} from '../errors.js';
import { assertJsonPayloadSize } from '../utils/serialization.js';
import { parseJson } from '../utils/parse-json.js';
import { createPromiseWithResolvers } from '../utils/promise-with-resolvers.js';
import { buildGuestRuntimeSetupSource, wrapUserCode } from './guest-sources.js';
import { normalizeUserSourceStack } from './source-stack.js';
import type { WorkerBridgeResponse, WorkerRunMessage } from './protocol.js';
import { assertMainToWorkerMessage } from './protocol-validation.js';

if (!parentPort) {
  throw new Error('JavaScript runtime worker must run inside a worker thread');
}

const pendingBridgeRequests = new Map<
  string,
  {
    context: QuickJS;
    deferred: Deferred;
    invocationId: string;
    resetDateNow?: JSValueHandle;
  }
>();
let activeInvocationId: string | undefined;
let bridgeRequestCounter = 0;
let bridgeIdleGeneration = 0;
let embeddedQuickJsWasmModulePromise: Promise<WebAssembly.Module> | undefined;
let activeCancellation:
  | {
      invocationId: string;
      cancel: () => void;
      fail: (error: unknown) => void;
    }
  | undefined;
let pendingInvocationFailure:
  | { invocationId: string; error: unknown }
  | undefined;
const MAX_SAFE_WASI_STACK_LIMIT_BYTES = 512 * 1024;

parentPort.on('message', async (value: unknown) => {
  try {
    await handleMainMessage(value);
  } catch (error) {
    handleMainMessageFailure(error);
  }
});

async function handleMainMessage(value: unknown): Promise<void> {
  assertMainToWorkerMessage(value);
  const message = value;
  if (message.type === 'cancel') {
    if (
      activeInvocationId !== message.invocationId ||
      activeCancellation?.invocationId !== message.invocationId
    ) {
      return;
    }
    activeCancellation.cancel();
    return;
  }
  if (message.type === 'bridge-response') {
    const pending = pendingBridgeRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    if (pending.invocationId !== message.invocationId) {
      throw new RunProtocolError(
        `Bridge response invocationId mismatch for request ${message.requestId}: expected ${pending.invocationId}, received ${message.invocationId}.`,
        {
          expectedInvocationId: pending.invocationId,
          receivedInvocationId: message.invocationId,
          requestId: message.requestId,
        },
      );
    }

    resolveBridgeResponse(
      pending.context,
      pending.deferred,
      message,
      pending.resetDateNow,
    );
    pendingBridgeRequests.delete(message.requestId);
    return;
  }

  if (message.type === 'run') {
    if (activeInvocationId !== undefined) {
      throw new RunProtocolError(
        `Worker received run ${message.invocationId} while ${activeInvocationId} is still active.`,
        {
          activeInvocationId,
          receivedInvocationId: message.invocationId,
        },
      );
    }

    activeInvocationId = message.invocationId;
    bridgeRequestCounter = 0;
    bridgeIdleGeneration += 1;
    try {
      await run(message);
    } finally {
      activeInvocationId = undefined;
      if (pendingInvocationFailure?.invocationId === message.invocationId) {
        pendingInvocationFailure = undefined;
      }
    }
  }
}

function handleMainMessageFailure(error: unknown): void {
  if (activeInvocationId === undefined) {
    try {
      writeSync(
        2,
        `${JSON.stringify({
          error: serializeError(error),
          type: 'run-worker-message-error',
        })}\n`,
      );
    } catch {
      // The worker has no active invocation to report the protocol error to.
    }
    return;
  }
  pendingInvocationFailure ??= {
    error,
    invocationId: activeInvocationId,
  };
  activeCancellation?.fail(error);
}

async function run(message: WorkerRunMessage): Promise<void> {
  try {
    const valueJson = await execute(message);
    parentPort?.postMessage({
      invocationId: message.invocationId,
      success: true,
      type: 'result',
      valueJson,
    });
  } catch (error) {
    parentPort?.postMessage({
      error: serializeError(error),
      invocationId: message.invocationId,
      success: false,
      type: 'result',
    });
  } finally {
    bridgeIdleGeneration += 1;
    parentPort?.postMessage({
      invocationId: message.invocationId,
      type: 'ready',
    });
  }
}

async function execute(message: WorkerRunMessage): Promise<string> {
  const deadline = Date.now() + message.options.executionTimeoutMs;
  let interruptChecks = 0;
  let cancelled = false;
  let executionTimedOut = false;
  const context = await createQuickJSContext({
    interruptHandler: () => {
      interruptChecks += 1;
      const timedOut = interruptChecks > 10_000 || Date.now() > deadline;
      executionTimedOut ||= timedOut;
      return cancelled || timedOut;
    },
    maxStackSizeBytes: message.options.maxStackSizeBytes,
    memoryLimitBytes: message.options.memoryLimitBytes,
  });
  let bridgeFunctions: { invokeHostFunction: JSValueHandle } | undefined;
  let consoleFormatter: JSValueHandle | undefined;
  let determinismHandle: JSValueHandle | undefined;
  let resetDateNowHandle: JSValueHandle | undefined;
  let executionFailure: { error: unknown } | undefined;
  const getExecutionFailure = (): { error: unknown } | undefined =>
    executionFailure;
  activeCancellation = {
    cancel: () => {
      cancelled = true;
      rejectPendingBridgeRequests(
        context,
        message.invocationId,
        'Worker execution cancelled by host',
      );
    },
    fail: error => {
      executionFailure ??= { error };
      cancelled = true;
      rejectPendingBridgeRequests(
        context,
        message.invocationId,
        'Worker message processing failed',
      );
    },
    invocationId: message.invocationId,
  };
  if (pendingInvocationFailure?.invocationId === message.invocationId) {
    activeCancellation.fail(pendingInvocationFailure.error);
  }

  try {
    const initialFailure = getExecutionFailure();
    if (initialFailure !== undefined) {
      throw initialFailure.error;
    }
    consoleFormatter = installConsole(
      context,
      message.options.maxConsoleOutputBytes,
    );
    bridgeFunctions = createBridgeFunctions(
      context,
      message,
      () => resetDateNowHandle,
    );
    determinismHandle = jsToHandle(context, message.determinism);
    resetDateNowHandle = initializeGuestRuntime(
      context,
      message,
      bridgeFunctions.invokeHostFunction,
      determinismHandle,
    );
    const valueJson = await evaluateUserSource(context, message);
    const completedFailure = getExecutionFailure();
    if (completedFailure !== undefined) {
      throw completedFailure.error;
    }
    return valueJson;
  } catch (error) {
    const messageFailure = getExecutionFailure();
    if (messageFailure !== undefined) {
      throw messageFailure.error;
    }
    if (executionTimedOut) {
      throw new RunTimeoutError(message.options.timeoutMs);
    }
    throw error;
  } finally {
    if (activeCancellation?.invocationId === message.invocationId) {
      activeCancellation = undefined;
    }
    if (!cancelled) {
      rejectPendingBridgeRequests(
        context,
        message.invocationId,
        'Worker execution finished before bridge response',
      );
    }
    const pendingForInvocation = [...pendingBridgeRequests.entries()].filter(
      ([, pending]) => pending.invocationId === message.invocationId,
    );
    await Promise.allSettled(
      pendingForInvocation.map(([, pending]) => pending.deferred.settled),
    );
    for (const [requestId] of pendingForInvocation) {
      pendingBridgeRequests.delete(requestId);
    }
    disposeHandle(bridgeFunctions?.invokeHostFunction);
    disposeHandle(consoleFormatter);
    disposeHandle(resetDateNowHandle);
    disposeHandle(determinismHandle);
    context.dispose();
  }
}

function initializeGuestRuntime(
  context: QuickJS,
  message: WorkerRunMessage,
  invokeHostFunction: JSValueHandle,
  determinismHandle: JSValueHandle,
): JSValueHandle | undefined {
  const setupSource = buildGuestRuntimeSetupSource(
    message.hostFunctionNamespaces,
  );
  let setupFunction: JSValueHandle;
  try {
    setupFunction = context.evalCode(setupSource, 'run-setup.js');
  } catch (error) {
    throw toError(dumpQuickJSError(context, error));
  }
  try {
    let setupResult: JSValueHandle;
    try {
      setupResult = context.callFunction(
        setupFunction,
        context.undefined,
        invokeHostFunction,
        determinismHandle,
      );
    } catch (error) {
      throw toError(dumpQuickJSError(context, error));
    }
    try {
      return setupResult.getProp('resetDateNow');
    } finally {
      setupResult.dispose();
    }
  } finally {
    setupFunction.dispose();
  }
}

function disposeHandle(handle: JSValueHandle | undefined): void {
  if (handle !== undefined && !handle.disposed) {
    handle.dispose();
  }
}

async function evaluateUserSource(
  context: QuickJS,
  message: WorkerRunMessage,
): Promise<string> {
  const wrapped = wrapUserCode(message.source);
  try {
    context.evalCode(wrapped, 'run.js').dispose();
  } catch (error) {
    throw toUserSourceError(dumpQuickJSError(context, error), message.source);
  }

  const promiseHandle = context.global.getProp('__runResult');
  const resolvedResult = await resolveQuickJSPromise(context, promiseHandle);
  if (!promiseHandle.disposed) {
    promiseHandle.dispose();
  }
  if ('error' in resolvedResult) {
    const error = dumpQuickJSErrorHandle(context, resolvedResult.error);
    if (!resolvedResult.error.disposed) {
      resolvedResult.error.dispose();
    }
    throw toUserSourceError(error, message.source);
  }

  const valueJson = serializeQuickJSJsonPayload(context, resolvedResult.value);
  if (!resolvedResult.value.disposed) {
    resolvedResult.value.dispose();
  }
  assertJsonPayloadSize(
    valueJson,
    message.options.maxResultBytes,
    'JavaScript runtime result',
  );
  return valueJson;
}

function rejectPendingBridgeRequests(
  context: QuickJS,
  invocationId: string,
  message: string,
): void {
  let rejected = false;
  for (const pending of pendingBridgeRequests.values()) {
    if (pending.invocationId !== invocationId) {
      continue;
    }
    const error = context.newError(message);
    pending.deferred.reject(error);
    error.dispose();
    rejected = true;
  }
  if (rejected) {
    context.executePendingJobs();
  }
}

async function createQuickJSContext(options: {
  interruptHandler: () => boolean;
  maxStackSizeBytes: number;
  memoryLimitBytes: number;
}): Promise<QuickJS> {
  const embeddedWasmBase64 = getEmbeddedQuickJsWasmBase64();
  if (embeddedWasmBase64 === undefined) {
    throw new Error('Embedded QuickJS WASM bytes are unavailable.');
  }
  return QuickJS.create({
    interruptHandler: options.interruptHandler,
    maxStackSize: Math.min(
      options.maxStackSizeBytes,
      MAX_SAFE_WASI_STACK_LIMIT_BYTES,
    ),
    memoryLimit: options.memoryLimitBytes,
    wasm: await getEmbeddedQuickJsWasmModule(embeddedWasmBase64),
  });
}

function getEmbeddedQuickJsWasmBase64(): string | undefined {
  return (
    globalThis as typeof globalThis & {
      __RUN_QUICKJS_WASM_BASE64__?: unknown;
    }
  ).__RUN_QUICKJS_WASM_BASE64__ as string | undefined;
}

function getEmbeddedQuickJsWasmModule(
  wasmBase64: string,
): Promise<WebAssembly.Module> {
  embeddedQuickJsWasmModulePromise ??= WebAssembly.compile(
    decodeBase64ArrayBuffer(wasmBase64),
  );
  return embeddedQuickJsWasmModulePromise;
}

function decodeBase64ArrayBuffer(value: string): ArrayBuffer {
  const bytes = Buffer.from(value, 'base64');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function serializeQuickJSJsonPayload(
  context: QuickJS,
  value: JSValueHandle,
): string {
  const serialize = context.global.getProp('__runSerializeJsonPayload');
  try {
    let result: JSValueHandle;
    try {
      result = context.callFunction(serialize, context.undefined, value);
    } catch (error) {
      throw toError(dumpQuickJSError(context, error));
    }
    try {
      return result.toString();
    } finally {
      result.dispose();
    }
  } finally {
    if (!serialize.disposed) {
      serialize.dispose();
    }
  }
}

function installConsole(
  context: QuickJS,
  maxOutputBytes: number,
): JSValueHandle {
  const outputBudget = { remainingBytes: maxOutputBytes };
  let boundedFormatter: JSValueHandle;
  try {
    boundedFormatter = context.evalCode(`
      (value, maxChars) => {
        let rendered;
        try {
          rendered = typeof value === 'string' ? value : JSON.stringify(value);
        } catch {}
        return String(rendered === undefined ? value : rendered)
        .slice(0, maxChars)
        .replace(/[\\u0000-\\u001f\\u007f-\\u009f]/gu, character =>
          character === '\\t'
            ? '\\t'
            : '\\\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
        );
      }
    `);
  } catch (error) {
    throw toError(dumpQuickJSError(context, error));
  }
  const consoleHandle = context.newObject();
  const handles = [
    [
      'log',
      createConsoleFunction(
        context,
        'console.log',
        'stdout',
        outputBudget,
        boundedFormatter,
      ),
    ],
    [
      'info',
      createConsoleFunction(
        context,
        'console.info',
        'stdout',
        outputBudget,
        boundedFormatter,
      ),
    ],
    [
      'debug',
      createConsoleFunction(
        context,
        'console.debug',
        'stdout',
        outputBudget,
        boundedFormatter,
      ),
    ],
    [
      'error',
      createConsoleFunction(
        context,
        'console.error',
        'stderr',
        outputBudget,
        boundedFormatter,
      ),
    ],
  ] as const;

  for (const [name, handle] of handles) {
    context.setProp(consoleHandle, name, handle);
  }
  context.setProp(context.global, 'console', consoleHandle);

  for (const [, handle] of handles) {
    handle.dispose();
  }
  consoleHandle.dispose();
  return boundedFormatter;
}

function createConsoleFunction(
  context: QuickJS,
  name: string,
  stream: 'stdout' | 'stderr',
  outputBudget: { remainingBytes: number },
  boundedFormatter: JSValueHandle,
): JSValueHandle {
  return context.newFunction(name, (...args: JSValueHandle[]) => {
    if (outputBudget.remainingBytes === 0) {
      return context.undefined;
    }
    const maxBytesPerArgument = Math.max(
      1,
      Math.floor(outputBudget.remainingBytes / Math.max(1, args.length)),
    );
    const values = args.map(arg =>
      formatConsoleArg(context, boundedFormatter, arg, maxBytesPerArgument),
    );
    const line = formatWithOptions({ colors: false, depth: 0 }, ...values);
    const output = `${line}\n`;
    const outputBytes = Buffer.byteLength(output);
    if (outputBytes > outputBudget.remainingBytes) {
      outputBudget.remainingBytes = 0;
      return context.undefined;
    }
    outputBudget.remainingBytes -= outputBytes;
    writeSync(stream === 'stderr' ? 2 : 1, output);
    return context.undefined;
  });
}

function formatConsoleArg(
  context: QuickJS,
  boundedFormatter: JSValueHandle,
  arg: JSValueHandle,
  remainingBytes: number,
): string {
  const maxCharsHandle = context.newNumber(remainingBytes);
  try {
    const result = context.callFunction(
      boundedFormatter,
      context.undefined,
      arg,
      maxCharsHandle,
    );
    const value = result.toString();
    result.dispose();
    if (context.typeof(arg) === 'object') {
      try {
        return formatWithOptions({ colors: false, depth: 4 }, parseJson(value));
      } catch {
        // A bounded/truncated JSON preview is still safe to print as text.
      }
    }
    return value;
  } catch {
    return '[Unprintable QuickJS value]';
  } finally {
    maxCharsHandle.dispose();
  }
}

function createBridgeFunctions(
  context: QuickJS,
  message: WorkerRunMessage,
  getResetDateNow: () => JSValueHandle | undefined,
): { invokeHostFunction: JSValueHandle } {
  const invokeHostFunction = context.newFunction(
    '__runInvokeHostFunction',
    (hostFunctionNameHandle: JSValueHandle, inputJsonHandle: JSValueHandle) => {
      const hostFunctionName = hostFunctionNameHandle.toString();
      const inputJson = inputJsonHandle.toString();
      if (Buffer.byteLength(hostFunctionName) > 1024) {
        throw new Error('Host function name exceeds 1024 bytes.');
      }
      if (
        Buffer.byteLength(inputJson) > message.options.maxHostFunctionInputBytes
      ) {
        throw new Error(
          `Host function arguments exceed the ${message.options.maxHostFunctionInputBytes} byte size limit.`,
        );
      }
      return requestHost(
        context,
        message.invocationId,
        {
          hostFunctionName,
          inputJson,
        },
        getResetDateNow(),
      );
    },
  );

  return { invokeHostFunction };
}

function requestHost(
  context: QuickJS,
  invocationId: string,
  payload: Record<string, unknown>,
  resetDateNow?: JSValueHandle,
): JSValueHandle {
  bridgeRequestCounter += 1;
  const requestId = `${invocationId}:bridge-${bridgeRequestCounter}`;
  const deferred = context.newPromise();
  pendingBridgeRequests.set(requestId, {
    context,
    deferred,
    invocationId,
    ...(resetDateNow === undefined ? {} : { resetDateNow }),
  });
  completeDeferredWhenSettled(context, deferred);
  parentPort?.postMessage({
    invocationId,
    requestId,
    type: 'host-function-request',
    ...payload,
  });
  bridgeIdleGeneration += 1;
  const idleGeneration = bridgeIdleGeneration;
  setImmediate(() => {
    if (idleGeneration === bridgeIdleGeneration) {
      parentPort?.postMessage({
        invocationId,
        requestCount: bridgeRequestCounter,
        type: 'bridge-idle',
      });
    }
  });
  return deferred.handle;
}

async function completeDeferredWhenSettled(
  context: QuickJS,
  deferred: Deferred,
): Promise<void> {
  await deferred.settled;
  context.executePendingJobs();
}

function resolveBridgeResponse(
  context: QuickJS,
  deferred: Deferred,
  message: WorkerBridgeResponse,
  resetDateNow?: JSValueHandle,
): void {
  resetGuestDateNow(context, resetDateNow, message.dateNowMs);
  if (message.success) {
    const value = context.newString(message.valueJson ?? '');
    deferred.resolve(value);
    value.dispose();
    context.executePendingJobs();
    return;
  }
  const error = createBridgeErrorHandle(context, message.error);
  deferred.reject(error);
  error.dispose();
  context.executePendingJobs();
}

function resetGuestDateNow(
  context: QuickJS,
  resetDateNow: JSValueHandle | undefined,
  dateNowMs: number,
): void {
  if (resetDateNow === undefined) {
    return;
  }
  const value = context.newNumber(dateNowMs);
  try {
    try {
      context.callFunction(resetDateNow, context.undefined, value).dispose();
    } catch (error) {
      throw toError(dumpQuickJSError(context, error));
    }
  } finally {
    value.dispose();
  }
}

function jsToHandle(context: QuickJS, value: unknown): JSValueHandle {
  if (value === null) {
    return context.null;
  }
  if (typeof value === 'string') {
    return context.newString(value);
  }
  if (typeof value === 'number') {
    return context.newNumber(value);
  }
  if (typeof value === 'boolean') {
    return value ? context.true : context.false;
  }
  if (Array.isArray(value)) {
    const result = context.newArray();
    for (const [index, item] of value.entries()) {
      const handle = jsToHandle(context, item);
      context.setProp(result, String(index), handle);
      handle.dispose();
    }
    return result;
  }
  if (typeof value === 'object') {
    const result = context.newObject();
    for (const [key, item] of Object.entries(value)) {
      const handle = jsToHandle(context, item);
      context.setProp(result, key, handle);
      handle.dispose();
    }
    return result;
  }
  return context.undefined;
}

function drainPendingJobs(context: QuickJS): void {
  context.executePendingJobs();
}

async function resolveQuickJSPromise(
  context: QuickJS,
  promiseHandle: JSValueHandle,
) {
  const resolved = context.resolvePromise(promiseHandle);
  const notSettled = Symbol('not-settled');
  for (;;) {
    drainPendingJobs(context);
    const nextTurn = createPromiseWithResolvers<typeof notSettled>();
    setTimeout(() => nextTurn.resolve(notSettled), 0);
    const result = await Promise.race([resolved, nextTurn.promise]);
    if (result !== notSettled) {
      drainPendingJobs(context);
      return result;
    }
  }
}

const GUEST_FORBIDDEN_ERROR_CODES = new Set([
  'RUN_ABORTED',
  'RUN_CONCURRENCY_LIMIT',
  'RUN_DETACHED_BRIDGE_REQUEST',
  'RUN_PROTOCOL_ERROR',
  'RUN_SOURCE_TOO_LARGE',
  'RUN_TIMEOUT',
]);

function toError(value: unknown, filterGuestCode = false): Error {
  if (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof (value as { message?: unknown }).message === 'string'
  ) {
    const errorValue = value as {
      message: string;
      name?: string;
      stack?: string;
      code?: string;
      details?: unknown;
    };
    const error = new Error(errorValue.message);
    const { name } = errorValue;
    if (typeof name === 'string') {
      error.name = name;
    }
    if (
      'stack' in value &&
      typeof (value as { stack?: unknown }).stack === 'string'
    ) {
      error.stack = (value as { stack: string }).stack;
    }
    if (
      errorValue.code !== undefined &&
      (!filterGuestCode ||
        typeof errorValue.code !== 'string' ||
        !GUEST_FORBIDDEN_ERROR_CODES.has(errorValue.code))
    ) {
      Object.defineProperty(error, 'code', {
        enumerable: true,
        value: errorValue.code,
      });
    }
    if (errorValue.details !== undefined) {
      Object.defineProperty(error, 'details', {
        enumerable: true,
        value: errorValue.details,
      });
    }
    return error;
  }
  return new Error(String(value));
}

function toUserSourceError(value: unknown, source: string): Error {
  const error = toError(value, true);
  error.stack = normalizeUserSourceStack({
    message: error.message,
    name: error.name,
    source,
    stack: error.stack,
  });
  return error;
}

function createBridgeErrorHandle(
  context: QuickJS,
  error: WorkerBridgeResponse['error'],
): JSValueHandle {
  const handle = context.newError(
    error?.message ?? 'Host bridge request failed.',
  );
  if (!error) {
    return handle;
  }
  const name = context.newString(error.name);
  context.setProp(handle, 'name', name);
  name.dispose();
  if (error.code !== undefined) {
    const code = context.newString(error.code);
    context.setProp(handle, 'code', code);
    code.dispose();
  }
  return handle;
}

function dumpQuickJSError(context: QuickJS, error: unknown): unknown {
  if (!(error instanceof JSException)) {
    return error;
  }
  try {
    return dumpQuickJSErrorHandle(context, error.handle);
  } finally {
    error.dispose();
  }
}

function dumpQuickJSErrorHandle(
  context: QuickJS,
  handle: JSValueHandle,
): unknown {
  const dumped = context.dump(handle);
  if (!(dumped instanceof Error)) {
    return dumped;
  }

  for (const property of ['code', 'details'] as const) {
    const descriptor = handle.getOwnPropertyDescriptor(property);
    if (descriptor?.value === undefined) {
      descriptor?.get?.dispose();
      descriptor?.set?.dispose();
      continue;
    }
    try {
      Object.defineProperty(dumped, property, {
        enumerable: true,
        value: context.dump(descriptor.value),
      });
    } finally {
      descriptor.value.dispose();
    }
  }
  return dumped;
}
