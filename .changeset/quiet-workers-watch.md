---
'run': patch
---

Fix `RunProtocolError` under Node.js watch mode by disabling dependency reporting in sandbox workers while preserving file watching in the host process.
