import { createRequire } from 'node:module';

/**
 * The version of this CLI installation, sent as `x-aivi-client` on the few
 * API calls (`whoami`, `links`, `status`) the CLI makes without
 * `createHostClient` — it may import nothing outside its own dependencies
 * (the packaging test is that gate), so it cannot ride the host's client.
 * `@aivi/cli` and `@aivi/host` share one version through the changesets
 * `fixed` group, so this number is the API version this CLI speaks.
 */
export const aiviVersion: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
