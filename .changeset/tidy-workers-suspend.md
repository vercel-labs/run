---
'run': patch
---

Fix interruptions timing out when guest `catch` or `finally` handlers run during worker cancellation. Suspension now discards the cancelled guest context without executing its handlers, while preserving worker reuse and continuation replay.

Report uncaught guest errors as `RUN_USER_SOURCE_ERROR` so callers can distinguish source failures from infrastructure failures. Trusted host and runtime error codes are preserved; guest-authored codes are replaced.
