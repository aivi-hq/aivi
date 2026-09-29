/**
 * The **project-setup** contract: how a plugin helps set up a new project for
 * the *role* it plays (`forge` or `tracker` — core's system vocabulary, never
 * a plugin name). `aivi projects add` walks the roles in order and, for each,
 * runs the one configured plugin that serves it; the plugin asks its own
 * platform questions and hands back the config section core writes under the
 * project. Core writes bytes and reads none of them — the types live in the
 * plugin's own `projectSchema`. A forge owns the checkout (it clones); a
 * plugin that clones says so, and with no forge the setup leaves an untracked
 * directory instead.
 *
 * Everything platform-specific lives in the plugin; the runner only wires the
 * context (the same clack, fetch and store the plugin's `./setup` gets) and
 * threads the project name from one role to the next so it is asked once.
 */

import type { OutputBlock, ProjectRole } from '@aivi/core';
import type { Store } from '@aivi/host';
import type * as prompts from '@clack/prompts';
import { PluginSetupCancelled } from './setup.ts';

export { PluginSetupCancelled };

/** What the runner hands a project contributor. */
export interface ProjectSetupContext {
  /** The aivi home that owns `config.json` and `.env`. */
  home: string;
  configPath: string;
  /** The plugin's own config block (`config.plugins.<id>`) as written — its
   *  credentials live in the environment, so this is ids and options. */
  config: Record<string, unknown>;
  /** The plugin's own `projectDefaults.<id>` section as written — the
   *  company-wide convention this project inherits unless it says otherwise.
   *  Core hands the plugin its own section and reads nothing in it. */
  projectDefaults?: Record<string, unknown>;
  /** The project name chosen by an earlier role, or undefined when this role
   *  is the first to settle it (and so offers the default). */
  projectId?: string;
  /** Raw JSON on stdout when the value is for copying (core's `print`). */
  print(value: unknown, output?: OutputBlock[] | string): void;
  /** The very `@clack/prompts` the runner renders with; a cancelled prompt
   *  throws `PluginSetupCancelled` and nothing further is written. */
  prompts: typeof prompts;
  /** Platform calls the contributor verifies with; the runner supplies fetch. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The home's SQLite store, open for the callback and closed after. */
  withStore<T>(fn: (store: Store) => T | Promise<T>): Promise<T>;
}

/** What a project contributor hands back for the project. */
export interface ProjectSetupResult {
  /** The project name, settled here: the role's own default (a forge's repo
   *  name, a tracker's team name) or the one handed in by an earlier role. */
  id: string;
  /** The section core writes at `projects.<id>.<moduleId>`, validated against
   *  this plugin's own `projectSchema`; absent means the role wrote nothing. */
  section?: Record<string, unknown>;
  /** True when this contributor created the checkout (`projects/<id>/source`);
   *  a forge clones. With no clone the setup leaves an untracked directory. */
  cloned?: boolean;
}

/** The declaration a plugin package makes at its `./setupProject` subpath:
 *  the role it serves and the flow that sets a project up for it. A package
 *  with no `./setupProject` export serves no role and is never offered. */
export interface ProjectContributor {
  /** The role this contributor serves from core's system vocabulary. Absent
   *  means it serves **no role**: it jumps in *after* the roles (forge, then
   *  tracker) are done, and adds its own project section — a plugin that wants
   *  a say in a new project without claiming to be the source host or the
   *  ticket system. */
  role?: ProjectRole;
  setup(ctx: ProjectSetupContext): Promise<ProjectSetupResult>;
}
