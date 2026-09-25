/**
 * The version of the aivi wire API — the version of `@aivi/host`, which owns
 * it and whose `client` export is every first-party caller. The client sends
 * it as `x-aivi-client` and the host gates on it, so client and server can
 * never disagree about who they are; a test keeps it equal to the host's
 * `package.json`.
 */
export const aiviVersion = '0.6.0';
