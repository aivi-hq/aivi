---
"@aivi/host": patch
---

Cancel the orchestrator's timers when the host shuts down, as the dispatcher already does. A parked run's keep-alive (5 minutes by default) and a pending turn-end wait kept running through shutdown and could fire into a host that was ending. No timer is started after the signal either. The boot pass starts the keep-alive of parked runs again, as before.
