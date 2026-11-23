---
"@aivi/host": patch
---

Draw another link code when a new one collides with a live one. The retry checked for an error code that `node:sqlite` never sets, so `aivi link` ended with a database error on a collision instead of drawing again. The code is now inserted with `ON CONFLICT DO NOTHING`, and drawn again when nothing was inserted.
