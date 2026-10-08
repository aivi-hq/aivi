/** The plugin removal plumbing behind `aivi remove`: drop the config a plugin
 *  wrote, so a plugin that leaves takes its configuration with it and no
 *  block stands for a plugin that is no longer listed. That is **all three**
 *  places a plugin writes: the `plugins.<id>` block, the `projectDefaults.<id>`
 *  section, and the `<id>` section of every project. The composed schema
 *  refuses a leftover section of an unlisted plugin as an unrecognized key —
 *  a removal that left one behind broke the home: the next `aivi serve` and
 *  every CLI that loads the config failed to load it (found live when
 *  `aivi remove @aivi/tracker-linear` left `projects.aivi` unusable). The
 *  module id is the package's own declaration — read from its `./config` while
 *  the package is still installed, before npm is asked to take it away. */
import { readFileSync } from 'node:fs';
import { deleteConfigBlock } from '@aivi/core';

/** Remove the config the named package owns: its `plugins.<id>` block, its
 *  `projectDefaults.<id>` section and its section under every project.
 *  Answers the module id, whether a block actually left (a plugin listed with
 *  no block is a legal removal, and answers false for the block), and how
 *  many sections left. */
export async function pluginRemove(
  name: string,
  options: { configPath: string },
): Promise<{ moduleId: string; blockRemoved: boolean; sectionsRemoved: number }> {
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
  // The projects are read from the file itself: which projects exist is a
  // fact of the home, and each may hold the leaving plugin's section.
  const projects = Object.keys(
    ((JSON.parse(readFileSync(options.configPath, 'utf8')) as { projects?: unknown }).projects ?? {}) as Record<
      string,
      unknown
    >,
  );
  let sectionsRemoved = 0;
  if (await deleteConfigBlock(options.configPath, ['projectDefaults', moduleId])) sectionsRemoved++;
  for (const project of projects)
    if (await deleteConfigBlock(options.configPath, ['projects', project, moduleId])) sectionsRemoved++;
  return { moduleId, blockRemoved, sectionsRemoved };
}
