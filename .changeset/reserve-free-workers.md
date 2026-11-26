---
'run': patch
---

Add `reserveWorkers` to `run()` input (default 0). Admission refuses the invocation with `RunConcurrencyError` (`RUN_CONCURRENCY_LIMIT`) when admitting it would leave fewer free workers than `reserveWorkers` under the worker cap or, without `setMaxWorkers()`, the dynamic memory budget, estimated at the invocation's own worker size. Long-running low-priority invocations can pass it to leave workers for other callers. When the reserve caused the refusal, the error message says so and `details` include `reserveWorkers`.
