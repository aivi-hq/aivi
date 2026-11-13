---
"@aivi/tracker-linear": patch
---

Always archive the temporary issue created by Linear setup, including when webhook verification, delegation or diary reads fail. If archiving also fails, report the leftover issue without replacing the original setup error.
