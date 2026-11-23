---
"@aivi/chrome": patch
---

Make `tab.off(event, listener)` take the listener off the event it is asked for. Tab listeners were remembered by listener alone, so a listener added to two events could not be taken off the first one (and then could not be taken off the second), and a listener added twice to one event was called twice but could be removed only once. They are remembered by event and listener now, and adding the same listener to the same event twice is one registration, as it is for an `EventTarget`.
