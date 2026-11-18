---
"@aivi/chrome": patch
---

Ignore a websocket frame that is valid JSON but not an object. A frame of `null` made the connection's message listener throw, and Node reports an exception thrown in an event listener as an uncaught exception, so one odd frame could end the process. It is ignored now, like a frame that is not JSON.
