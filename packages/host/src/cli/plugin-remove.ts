/** The plugin removal plumbing behind `aivi remove`: drop the config block a
 *  plugin's `./setup` wrote, so a plugin that leaves takes its configuration
 *  with it and no block stands for a plugin that is no longer listed. The
 *  module id is the package's own declaration — read from its `./config` while
 *  the package is still installed, before npm is asked to take it away. */
import { deleteConfigBlock } from '@aivi/core';

/** Remove the `plugins.<id>` block the named package owns; answers the module
 *  id and whether a block actually left (a plugin listed with no block is a
 *  legal removal, and answers false for the block). */
export async function pluginRemove(
  name: string,
  options: { configPath: string },
): Promise<{ moduleId: string; blockRemoved: boolean }> {
  let declared: unknown;
  try {
    declared = (await import(import.meta.resolve(`${name}/config`))).plugin;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
      throw new Error(
        `${name} declares no ./config here, so its module id is unknown; drop its block from config.json by hand if it has one, and its list entry from app/package.json.`,
      );
    throw error;
  }
  const moduleId = (declared as { id?: unknown } | undefined)?.id;
  if (typeof moduleId !== 'string')
    throw new Error(`${name}/config declares no module id; drop its block from config.json by hand if it has one.`);
  const blockRemoved = await deleteConfigBlock(options.configPath, ['plugins', moduleId]);
  return { moduleId, blockRemoved };
}
