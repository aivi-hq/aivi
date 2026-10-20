/** The Meet plugin's registry declaration, at its `./config` subpath: the
 *  module id, the block's own schema, and the bridge to the module code.
 *  The CLI imports this for every command, so nothing here launches a
 *  browser.
 *
 *  The name says the platform, not a chat channel: `channel` is OpenCode's
 *  word for a chat session, and Meet is a conferencing solution any plugin
 *  may want a face in (ruled 2026-10-13). The face is not this package's
 *  either — core owns it (`aivi face`); this package owns the buttons. */
import type { AiviPlugin } from '@aivi/plugin';
import { z } from 'zod';

export const MODULE_ID = 'google-meet';

/**
 * The Meet module: what name aivi wears at the waiting room and how long
 * the human gets to admit it. Its block lives at `plugins.google-meet`;
 * the `aivi-plugins` list says whether the module runs. Nothing here needs
 * a secret: Meet joins as a guest.
 */
export const meetConfigSchema = z.strictObject({
  /** Typed into the waiting-room name box; Meet shows it while the host decides. */
  name: z.string().min(1).default('aivi'),
  /** How long the pre-join screens get to appear before the join is called a failure. */
  joinTimeoutMs: z.number().int().min(1000).default(60_000),
  /** How long the host gets to admit aivi after `Ask to join`. */
  askTimeoutMs: z
    .number()
    .int()
    .min(1000)
    .default(15 * 60_000),
  /** What the room IS (ruled 2026-10-13: mode belongs to the room's opener):
   *  `call` — closed speech prompts aivi and barge-in lives; `meeting` —
   *  lines append quietly until the wake phrase. */
  mode: z
    .enum(['call', 'meeting'])
    .default('call')
    .describe('What the room is: call (conversation) or meeting (record until the wake phrase).'),
  /** The OpenCode agent the room's sessions run as. */
  agent: z.string().default('assistant'),
  /** How quiet before the NEXT exchange starts a fresh conversation instead
   *  of resuming the call's session (0: fresh every join, false: one
   *  session forever). Absent: the voice block's `resumeMinutes` — but a
   *  meeting is not a channel: many want the next call to start clean
   *  while Discord keeps its long memory. */
  resumeMinutes: z.union([z.number().int().min(0), z.literal(false)]).optional(),
  /** Dispatcher pool these meetings draw capacity from (a name in
   *  `dispatcher.pools`). Absent: the voice block's `pool`. Meetings are a
   *  category of their own: seat them apart from calls if you want. */
  pool: z.string().min(1).optional(),
  /** Default true: the meeting runs headless, no window. False opens a
   *  real Chrome window — the debug look (watch every click), and the
   *  escape hatch if a platform ever refuses the headless browser again
   *  (2026-10-14: Meet's verdict fluctuated; headed always passed). */
  headless: z.boolean().default(true),
});
export type MeetConfig = z.infer<typeof meetConfigSchema>;

export const plugin: AiviPlugin = {
  id: MODULE_ID,
  configSchema: meetConfigSchema,
  createModule: async config => (await import('./module.ts')).createMeetModule(meetConfigSchema.parse(config)),
};
