---
"@aivi/core": patch
---

Give the shared browser back when a face tab cannot be closed. `FaceTab.close()` closed its tab and only then released the browser. A browser that had crashed cannot close a tab, so the close rejected and the release never ran: the dead browser stayed registered, and every later `openFaceTab` reused it and failed, until the host restarted. The browser is released whether or not the tab closes, and the caller still gets the close error.
