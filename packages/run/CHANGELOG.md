# run

## 2.1.11

### Patch Changes

- 5803b0d: Fix `RunProtocolError` under Node.js watch mode by disabling dependency reporting in sandbox workers while preserving file watching in the host process.

## 2.1.10

### Patch Changes

- dd5c03e: fix(run): recheck shared state to avoid race condition

## 2.1.9

### Patch Changes

- 2e2b1da: Release bridge-owned promise handles after async host responses settle, release synchronous response handles after transferring them to guest ownership, and upgrade quickjs-wasi to release both deferred resolvers, allowing discarded response payloads to be collected.
- 142e646: Avoid retaining completed asynchronous host call replay history and applying continuation size limits when continuations are not configured.

## 2.1.8

### Patch Changes

- 1b28a18: Add `limits.cpuTimeoutMs` (default 10 seconds), which bounds the time the worker spends running guest JavaScript in one invocation. Time spent awaiting asynchronous host functions or blocked in synchronous host functions and module loaders does not count, and each continuation resume starts with a fresh budget. Exceeding it fails with the new `RunCpuTimeoutError` (`RUN_CPU_TIMEOUT`), even when an interruption is pending. The limit only takes effect when it is lower than `timeoutMs`.

  This replaces the hidden 10,000 interrupt-check cap, which stopped long loops and large host-function workloads after about a second of guest work, regardless of `timeoutMs`, and surfaced as `RUN_TIMEOUT` or `InternalError: interrupted`. `timeoutMs` keeps its meaning as the wall-clock ceiling for the whole invocation.

## 2.1.7

### Patch Changes

- 33a2992: fix(run): preserve continuation compatibility and bridge limit errors

## 2.1.6

### Patch Changes

- 6a88d16: fix: enforce aggregate bridge budget for accepted and rejected requests

## 2.1.5

### Patch Changes

- 7daedc4: feat(run): allow resumption for interruptions after partial resolves

## 2.1.4

### Patch Changes

- 6560f4d: Fix interruptions timing out when guest `catch` or `finally` handlers run during worker cancellation. Suspension now discards the cancelled guest context without executing its handlers, while preserving worker reuse and continuation replay.

  Report uncaught guest errors as `RUN_USER_SOURCE_ERROR` so callers can distinguish source failures from infrastructure failures. Trusted host and runtime error codes are preserved; guest-authored codes are replaced.

## 2.1.3

### Patch Changes

- aeb4ce0: Allow a module loader to serve dynamic imports without forcing entry source to be evaluated as an ES module.

## 2.1.2

### Patch Changes

- b3b7be5: fix(run): keep an error listener on pooled idle workers

## 2.1.1

### Patch Changes

- 3a2f001: Add a fail-closed banned-pattern security check and update unsafe object, error, bridge, and worker patterns to conform.
- 9d787ca: Generalize continuation replay ledgers to record synchronous host functions and native module-loader operations, allowing runs that use either capability to create and resume continuations without repeating recorded side effects.

## 2.1.0

### Minor Changes

- a0b1c49: Add synchronous host-function bindings and native static/dynamic ES module loading, with bounded per-invocation bridge transport, cancellation propagation, continuation safeguards, and Node.js 20 support.

## 2.0.3

### Patch Changes

- b54d912: fix forged serialization codes

## 2.0.2

### Patch Changes

- 5ed6e38: fix(run): prevent guest bypass of host-function tracking
- 527d753: feat: use quickjs-wasi for runtime
- b0d9762: fix(run): capture guest result serializer before execution

## 2.0.1

### Patch Changes

- b5fff36: feat: support bun runtime
