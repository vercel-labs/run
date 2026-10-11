---
'run': minor
---

Add `limits.cpuTimeoutMs` (default 10 seconds), which bounds the time the worker spends running guest JavaScript in one invocation. Time spent awaiting asynchronous host functions or blocked in synchronous host functions and module loaders does not count, and each continuation resume starts with a fresh budget. Exceeding it fails with the new `RunCpuTimeoutError` (`RUN_CPU_TIMEOUT`), even when an interruption is pending. The limit only takes effect when it is lower than `timeoutMs`.

This replaces the hidden 10,000 interrupt-check cap, which stopped long loops and large host-function workloads after about a second of guest work, regardless of `timeoutMs`, and surfaced as `RUN_TIMEOUT` or `InternalError: interrupted`. `timeoutMs` keeps its meaning as the wall-clock ceiling for the whole invocation.
