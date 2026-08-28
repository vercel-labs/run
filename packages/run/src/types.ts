/**
 * A host function made available to sandboxed JavaScript.
 */
export type HostFunction<
  ARGUMENTS extends unknown[] = unknown[],
  OUTPUT = unknown,
> = (...args: ARGUMENTS) => OUTPUT | Promise<OUTPUT>;

/**
 * Context supplied to each host function invocation.
 */
export interface HostFunctionContext {
  /** Signal aborted when the run is aborted, times out, or fails. */
  abortSignal: AbortSignal;
  /** Stable identifier for the current run attempt. */
  invocationId: string;
  /** Stable identifier for the logical run across every replay attempt. */
  logicalRunId: string;
  /** Stable identifier for this host function request within the run attempt. */
  requestId: string;
  /** One-based request order within the run attempt. */
  requestIndex: number;
  /** Fully qualified host function path, for example `tools.search`. */
  hostFunctionName: string;
  /** Interrupts this host function and suspends the run. */
  interrupt(payload: unknown): never;
  /** Present when an interrupted host function is reinvoked during replay. */
  resume?: HostFunctionResumeContext;
}

export interface HostFunctionResumeContext {
  interruptionId: string;
  payload: unknown;
  resolution: unknown;
}

/** A named collection of host functions. */
export type HostFunctionGroup = Record<string, HostFunction<never[], unknown>>;

/**
 * Host function groups installed as guest globals.
 *
 * A group named `tools` containing `search` is called as `tools.search()` in
 * sandboxed code.
 */
export type HostFunctions = Record<string, HostFunctionGroup>;

/** Host functions exposed to guest JavaScript with synchronous call semantics. */
export type SyncHostFunctions = HostFunctions;

/** Native ES module resolver used by QuickJS. */
export interface RunModuleLoader {
  /** Stable identity authenticated by continuations that use this loader. */
  identity?: string;
  /** Resolve a raw specifier relative to its importing module. */
  normalize?(specifier: string, importer: string): string | Promise<string>;
  /** Return source code for a normalized module specifier. */
  load(specifier: string): string | Promise<string>;
}

/** @internal */
export type HostFunctionManifest = ReadonlyMap<string, ReadonlySet<string>>;

/** Resource limits applied to one sandbox invocation. */
export interface RunLimits {
  /** @default `30_000` */
  timeoutMs?: number;
  /** @default `64 * 1024 * 1024` */
  memoryLimitBytes?: number;
  /** @default `2 * 1024 * 1024` */
  maxStackSizeBytes?: number;
  /** @default `1024 * 1024` */
  maxResultBytes?: number;
  /** @default `64 * 1024` */
  maxConsoleOutputBytes?: number;
  /** @default `256 * 1024` */
  maxSourceBytes?: number;
  /** @default `1024 * 1024` */
  maxHostFunctionArgumentsBytes?: number;
  /** @default `4 * 1024 * 1024` */
  maxHostFunctionOutputBytes?: number;
  /** @default `256` */
  maxBridgeRequests?: number;
  /** @default `32` */
  maxInFlightBridgeRequests?: number;
  /** @default `32 * 1024 * 1024` */
  maxContinuationBytes?: number;
}

/** Shared defaults used by a runner. */
export interface RunnerOptions<TOKEN = string> {
  limits?: RunLimits;
  /** Host functions exposed with synchronous guest call semantics. */
  syncHostFunctions?: SyncHostFunctions;
  /** HMAC key used for signed continuations. Cannot be combined with continuationCodec. */
  continuationSecret?: string | Uint8Array;
  continuationCodec?: ContinuationCodec<TOKEN>;
  /** Authenticated application/endpoint audience for every continuation. */
  continuationAudience?: string;
}

/** Input accepted by `run` and `Runner.run`. */
export interface RunInput<TOKEN = unknown> {
  /**
   * JavaScript or type-stripped TypeScript function-body source. Runtime type
   * stripping is used when provided natively by Node or Bun, or through the
   * optional TypeScript peer dependency on Node 20.
   * Top-level `await` and `return` are supported.
   */
  source: string;
  hostFunctions?: HostFunctions;
  /**
   * Optional native ES module loader. Its presence evaluates source as ESM;
   * entry-module evaluation completes with an undefined run value.
   */
  moduleLoader?: RunModuleLoader;
  abortSignal?: AbortSignal;
  limits?: RunLimits;
  continuation?: TOKEN;
  resolutions?: RunResolution[];
  /**
   * Serializable tenant, principal, or policy context authenticated by a
   * continuation and required unchanged when it is resumed.
   */
  continuationContext?: unknown;
}

/** Result of a completed sandbox invocation. */
export interface RunCompletedResult<OUTPUT = unknown> {
  status: 'completed';
  value: OUTPUT;
}

export interface RunInterruption<PAYLOAD = unknown> {
  id: string;
  hostFunctionName: string;
  /** Complete guest argument list for the interrupted host function call. */
  arguments: unknown[];
  payload: PAYLOAD;
}

export interface RunInterruptedResult<TOKEN = unknown> {
  status: 'interrupted';
  interruptions: RunInterruption[];
  /** Opaque bearer capability. Persist it without modifying it. */
  continuation: TOKEN;
}

export interface RunResolution<VALUE = unknown> {
  interruptionId: string;
  value: VALUE;
}

/**
 * Result of a sandbox invocation.
 */
export type RunResult<OUTPUT = unknown, TOKEN = unknown> =
  | RunCompletedResult<OUTPUT>
  | RunInterruptedResult<TOKEN>;

export interface ContinuationCodec<TOKEN = unknown> {
  encode(
    state: RunContinuationState,
    context?: ContinuationOperationContext,
  ): TOKEN | Promise<TOKEN>;
  decode(
    token: TOKEN,
    context?: ContinuationOperationContext,
  ): RunContinuationState | Promise<RunContinuationState>;
  /**
   * Optionally acquires a continuation for validation before consuming it.
   * The runtime commits valid continuations and rolls back failed or cancelled
   * decode attempts.
   */
  decodeTransaction?(
    token: TOKEN,
    context?: ContinuationOperationContext,
  ): ContinuationDecodeTransaction | Promise<ContinuationDecodeTransaction>;
}

export interface ContinuationDecodeTransaction {
  state: RunContinuationState;
  commit(): void | Promise<void>;
  rollback(): void | Promise<void>;
}

export interface ContinuationOperationContext {
  abortSignal: AbortSignal;
  deadlineMs: number;
}

/** Serializable replay state passed to a configured continuation codec. */
export interface RunContinuationState {
  version: 2;
  runtime: 'run-replay-v2';
  serde: 'run-js-v1';
  source: string;
  logicalRunId: string;
  scopeHash: string;
  determinism: RunDeterminismState;
  ledger: RunLedgerEntry[];
}

export interface RunDeterminismState {
  /** Initial Unix timestamp used by deterministic guest date APIs. */
  dateNowMs: number;
  /** 128-bit seed used by deterministic guest `Math.random()`. */
  randomSeed: string;
}

/**
 * One recorded host function outcome in a continuation ledger.
 *
 * The `bindingName` property name is part of the persisted continuation wire
 * format and must remain stable across package releases.
 */
export type RunLedgerEntry =
  | {
      bindingName: string;
      inputJson: string;
      status: 'fulfilled';
      settledOrder: number;
      dateNowMs: number;
      valueJson: string;
    }
  | {
      bindingName: string;
      inputJson: string;
      status: 'rejected';
      settledOrder: number;
      dateNowMs: number;
      error: SerializableError;
    }
  | {
      bindingName: string;
      inputJson: string;
      status: 'interrupted';
      interruptionId: string;
      payloadJson: string;
    }
  | {
      bridgeKind: 'sync-host' | 'module-normalize' | 'module-load';
      bindingName: string;
      inputJson: string;
      status: 'fulfilled';
      valueJson: string;
    }
  | {
      bridgeKind: 'sync-host' | 'module-normalize' | 'module-load';
      bindingName: string;
      inputJson: string;
      status: 'rejected';
      error: SerializableError;
    };

/** Configured JavaScript runner. */
export interface Runner<TOKEN = unknown> {
  run<OUTPUT = unknown>(
    input: RunInput<TOKEN>,
  ): Promise<RunResult<OUTPUT, TOKEN>>;
}

/** @internal */
export interface InternalRunInput extends RunInput<unknown> {
  hostFunctions: HostFunctions;
  hostFunctionManifest: HostFunctionManifest;
  syncHostFunctions: SyncHostFunctions;
  syncHostFunctionManifest: HostFunctionManifest;
  limits: RunLimits;
  continuationCodec: ContinuationCodec;
  continuationAudience: string;
}

/** @internal */
export interface NormalizedRunOptions {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxStackSizeBytes: number;
  maxResultBytes: number;
  maxConsoleOutputBytes: number;
  maxSourceBytes: number;
  maxHostFunctionInputBytes: number;
  maxHostFunctionOutputBytes: number;
  maxBridgeRequests: number;
  maxInFlightBridgeRequests: number;
  maxContinuationBytes: number;
}

/** @internal */
export interface SerializableError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  details?: unknown;
}
