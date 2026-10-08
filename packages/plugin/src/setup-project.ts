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

import type { OutputBlock, ProjectLaneInput, ProjectRole } from '@aivi/core';
import type * as prompts from '@clack/prompts';
import type { Store } from './module.ts';
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
  /** Whether a forge is configured in this home — so a checkout (and once
   *  a forge gives them, worktrees) is possible for this project. Core
   *  computes it from the configured plugins; contributors that could work
   *  a lane with git ask their own worktree questions with it. */
  forgeConfigured: boolean;
  /** Raw JSON on stdout when the value is for copying (core's `print`). */
  print(value: unknown, output?: OutputBlock[] | string): void;
  /** The very `@clack/prompts` the runner renders with; a cancelled prompt
   *  throws `PluginSetupCancelled` and nothing further is written. */
  prompts: typeof prompts;
  /** Platform calls the contributor verifies with; the runner supplies fetch. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The OpenCode agents that can work this project: what the project's
   *  checkout directory defines (its `.opencode/`), plus the global ones,
   *  minus the subagent-only ones — a lane works as the session's primary.
   *  The runner starts an OpenCode service when none answers, and a failure
   *  to reach or start one stops the setup — it is never swallowed. */
  agents(projectId: string): Promise<string[]>;
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
  /** The project's **core** `lanes` array — the ordered tracker workflow,
   *  written at `projects.<id>.lanes` and validated by core (unique names,
   *  every `next`/`previous` a lane of the array, the queue lane's rules).
   *  Lanes are core's fact;
   *  whoever knows the board — the tracker role — offers its order, and two
   *  contributors naming one workflow is an error, not a merge. */
  lanes?: ProjectLaneInput[];
  /** True when this contributor leaves a git checkout at `projects/<id>/source`
   *  — it cloned one, or the checkout was already there for the repository the
   *  person named. A forge owns the clone because cloning reaches `origin`.
   *  With no clone the setup leaves an untracked directory. */
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

/** The three answers to the lane question — "What kind of lane is this?" —
 *  in the person's own words. Every tracker wizard asks in these words: the
 *  explanation prints the labels, the question offers them, so they live in
 *  the kit once. `agent` asks who
 *  works the lane; `human` writes a bare lane — aivi ignores its tickets,
 *  and a finished run may move one in; `none` leaves the option out of the
 *  array: aivi never reads it and never moves a ticket into it. */
export const LANE_KIND = {
  agent: { value: 'agent', label: 'Agent: aivi delegates tickets in this lane to an agent' },
  human: {
    value: 'human',
    label: 'Human: aivi ignores tickets in this lane; it is only ever used as a queue or a destination',
  },
  none: { value: 'none', label: 'None: this lane is not part of aivi’s workflow' },
} as const;

/** The three answers as a type: whatever the person picked is one of them. */
export type LaneKind = (typeof LANE_KIND)[keyof typeof LANE_KIND]['value'];

/** The explanation — **one log entry before the first lane question**,
 *  never repeated per option. The queue sentence belongs in the same entry:
 *  a queue is the other thing a no-agent lane can be, and the difference
 *  between the two no-agent answers is the whole
 *  point of asking. `note` is the wizard's own first line — a tracker that
 *  cannot tell what an option means (GitHub) says so here. */
export function laneKindLines(note?: string): string[] {
  return [
    ...(note ? [note] : []),
    'Every option is asked, in board order. What each answer means:',
    `  ${LANE_KIND.agent.label}`,
    `  ${LANE_KIND.human.label}`,
    `  ${LANE_KIND.none.label}`,
    'A queue is where tickets wait while the working lanes are full: aivi moves the next ticket out of it as soon as a slot is free.',
  ];
}
