import type { Run } from '@aivi/core';
import { ConfigurationError } from './modules.ts';
import type { ExecutionContext, ExecutionResult } from './scheduler.ts';

/** Executes one run of one operation; what `kind: 'invocation'` tasks dispatch to. */
export type TaskHandler = (run: Run, context: ExecutionContext) => Promise<ExecutionResult>;

/** The task door as one module sees it: claims carry the module's own id. */
export interface TaskClaims {
  claim(name: string, handler: TaskHandler): void;
  release(name: string): void;
}

/**
 * The operations the host schedules but somebody else executes: the host's
 * own system work and a module's capabilities meet here as equals. An
 * invocation names one by string; each name is claimed *exactly once* — a
 * claim by a second owner is a `ConfigurationError`, because the loser's
 * capability would silently not exist. The same owner re-claiming (a module
 * restarted) replaces. A run of an unclaimed name fails with the name in the
 * reason; nothing is swallowed.
 */
export class TaskRegistry {
  private readonly claims = new Map<string, { owner: string; handler: TaskHandler }>();

  claim(owner: string, name: string, handler: TaskHandler): void {
    const existing = this.claims.get(name);
    if (existing && existing.owner !== owner)
      throw new ConfigurationError(
        `Operation "${name}" is already claimed by ${existing.owner}; each operation is claimed exactly once`,
      );
    this.claims.set(name, { owner, handler });
  }

  /** Let go of a name; afterwards a run of it fails until somebody claims it again. */
  release(owner: string, name: string): void {
    if (this.claims.get(name)?.owner === owner) this.claims.delete(name);
  }

  get(name: string): TaskHandler | undefined {
    return this.claims.get(name)?.handler;
  }

  /** Who can do what; for status and for the day a desktop app lists operations. */
  claimed(): { name: string; owner: string }[] {
    return [...this.claims.entries()].map(([name, claim]) => ({ name, owner: claim.owner }));
  }

  /** The door for one module: its id is baked in, so it cannot claim or release under another's name. */
  forModule(moduleId: string): TaskClaims {
    return {
      claim: (name, handler) => this.claim(moduleId, name, handler),
      release: name => this.release(moduleId, name),
    };
  }
}
