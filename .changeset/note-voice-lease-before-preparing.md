---
"@aivi/voice": patch
---

Note the slot a voice turn holds before its session is prepared. The lease was persisted only after the session had been created, so a crash during that step left a held slot that the next start's recovery did not know about. It is now persisted the moment the slot is granted.
