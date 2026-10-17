---
'run': patch
---

Stop retaining completed asynchronous host calls in the replay ledger when continuations are not configured. Ordinary runs can process successive host results and caught errors without exhausting the continuation size limit. Configured continuations retain their existing recording and size limits.
