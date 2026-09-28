/**
 * The registry declaration an installable plugin package makes at its `./config`
 * subpath. The `aivi-plugins` list in `<home>/app/package.json` names packages —
 * what npm installs, what `aivi add` takes; this declaration carries the other
 * identity a plugin has, its **module id**: the key of its block in `config.json`
 * (`plugins.<id>`), the logger category, the id `/status` reports. A third-party
 * package brings its own id, so npm names and config keys can never collide.
 *
 * The subpath is deliberately light: the CLI imports it for every command to
 * compose the config schema and mount commands, so it pulls the schema and not
 * the platform SDK — `createModule` reaches for the module code itself, lazily.
 */

import type { AiviModule } from '@aivi/host';
import type { z } from 'zod';

/** What the registry finds at a plugin package's `./config` subpath. */
export interface AiviPlugin<C = unknown> {
  /** The module id: the `plugins.<id>` config key, the logger category, the `/status` id. */
  id: string;
  /** The block's own schema: defaults, required fields and cross-field rules all live
   *  here. A plugin listed with no block is parsed against `configSchema.parse({})` —
   *  defaults, or this schema's own "enabled but unconfigured" complaint. */
  configSchema: z.ZodType<C>;
  /** Build the module `aivi serve` runs. `home` is the aivi home: a config path that
   *  was written relative resolves against it here — the plugin knows its own fields,
   *  core never does. */
  createModule(config: C, home: string): AiviModule | Promise<AiviModule>;
}
