# run

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
