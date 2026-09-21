---
'@aivi/app': minor
---

The channel and browser packages are no longer dependencies of `@aivi/app`:
each module's package loads when its config block enables it, so an
installation without a channel package runs every other command untouched.
Linear client resolution moved to `@aivi/linear` (`clientFor`).
