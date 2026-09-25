import type { Report } from '@aivi/core';
import { SESSION_DESTINATION } from '../reports.ts';
import type { ChannelModule, DeliveryContext, ReentryContext } from './contract.ts';

export type NativeReentry = (sessionId: string, text: string, context: ReentryContext) => Promise<void>;

/**
 * Routes job outcomes: a `channel` report goes to the module with that id; a
 * `session` report goes to the module that owns the session, else into the
 * native session through `native`. One registry, one registration per module.
 */
export class Channels {
  private readonly modules = new Map<string, ChannelModule>();
  private readonly native: NativeReentry | undefined;
  constructor(native?: NativeReentry) {
    this.native = native;
  }
  register(module: ChannelModule): () => void {
    if (module.id === SESSION_DESTINATION) throw new Error(`"${SESSION_DESTINATION}" is not a module id`);
    if (this.modules.has(module.id)) throw new Error(`Channel module ${module.id} is already registered`);
    this.modules.set(module.id, module);
    return () => {
      this.modules.delete(module.id);
    };
  }
  has(id: string): boolean {
    return this.modules.has(id);
  }
  /** A channel module has this session as a conversation; it is one, whatever its origin says. */
  ownsSession(sessionId: string): boolean {
    return this.ownerOf(sessionId) !== undefined;
  }
  /** The id of the module whose conversation this session is, if any. */
  ownerOf(sessionId: string): string | undefined {
    return [...this.modules.values()].find(m => m.ownsSession(sessionId))?.id;
  }
  /** The channels that can consume a link code, for `POST /links` and `aivi link`. */
  linkable(): { id: string; hint?: string }[] {
    return [...this.modules.values()].map(m => ({ id: m.id, ...(m.linkHint ? { hint: m.linkHint } : {}) }));
  }
  /** The platform channel of the conversation bound to a session, through the module that owns it. */
  async channelOf(sessionId: string): Promise<{ module: string; channel: string } | undefined> {
    const owner = [...this.modules.values()].find(m => m.ownsSession(sessionId));
    const channel = await owner?.channelOf(sessionId);
    return owner && channel ? { module: owner.id, channel } : undefined;
  }
  /** Validate a report before a job is created. Returns a reason when it could never be delivered. */
  refuse(report: Report): string | undefined {
    if (report.to === SESSION_DESTINATION)
      return this.native || this.modules.size ? undefined : 'No session delivery is available';
    const module = this.modules.get(report.module);
    if (!module) return `No channel module "${report.module}" is running`;
    if (!module.accepts(report.channel)) return `Module "${report.module}" does not allow posting to ${report.channel}`;
    return undefined;
  }
  async deliver(report: Report, text: string, context: DeliveryContext): Promise<void> {
    if (report.to === SESSION_DESTINATION) {
      if (!context.run) throw new Error('A session re-entry needs the run whose result it is');
      const reentry: ReentryContext = { ...context, run: context.run };
      const owner = [...this.modules.values()].find(m => m.ownsSession(report.session));
      if (owner) return owner.reenter(report.session, text, reentry);
      if (!this.native) throw new Error('No session delivery is available');
      return this.native(report.session, text, reentry);
    }
    const module = this.modules.get(report.module);
    if (!module) throw new Error(`No channel module "${report.module}" is running`);
    await module.post(report.channel, text, context);
  }
}
