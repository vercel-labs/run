---
'run': patch
---

Bound all guest error conversion before copying values to host memory to prevent excessive host allocation. Preserve error names, messages, and stacks when truncating oversized values or omitting diagnostic properties.
