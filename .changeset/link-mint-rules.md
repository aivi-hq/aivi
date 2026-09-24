---
'@aivi/host': minor
'@aivi/cli': minor
---

Link codes are minted for a named channel the person is not linked in yet:
`GET /v1/links` lists the running channels with the caller's binding state,
`POST /v1/links` requires a `channel` and refuses (404, 409) instead of
minting a code nothing can read or one a person cannot spend — one binding
per channel per person. `aivi link` picks among the eligible channels
(prompting when several) and says so without minting when nothing is
eligible; a terminal gets one sentence, a pipe the JSON record.
