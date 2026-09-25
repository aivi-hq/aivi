/**
 * The aivi wire API version this CLI speaks. The CLI is published thin — it
 * may import nothing outside its own dependencies (the packaging test is that
 * gate) — so this is a copy of `@aivi/core`'s `aiviVersion`, and core's
 * version test asserts the two never drift apart.
 */
export const aiviVersion = '0.6.0';
