---
"run": patch
---

Bound guest execution by `timeoutMs` alone instead of also stopping after 10,000 interrupt checks, and report deadlines that pass after an `await` as `RUN_TIMEOUT` instead of `RUN_ERROR`.
