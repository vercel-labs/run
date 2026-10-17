---
"run": patch
---

Dispose the bridge-owned promise handle after an async host response settles, so discarded guest responses can be collected.
