---
"run": patch
---

Release bridge-owned promise handles after async host responses settle, release synchronous response handles after transferring them to guest ownership, and upgrade quickjs-wasi to release both deferred resolvers, allowing discarded response payloads to be collected.
