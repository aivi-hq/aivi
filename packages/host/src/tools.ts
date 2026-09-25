import type { ServedTool, ToolDescriptor } from '@aivi/core';
import { toolDescriptorSchema } from '@aivi/core';
import { ConfigurationError } from './modules.ts';

/** One call as the generic dispatch hands it over: the envelope's ids, the model's input. */
export interface ToolCall {
  sessionId: string;
  messageId?: string;
  input: Record<string, unknown>;
}
/** What a claimed tool does; `POST /tools` dispatches to it. */
export type ToolHandler = (call: ToolCall) => Promise<unknown>;

/** A tool failed with an answer for the agent: this status and message reach the caller. */
export class ToolError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The tool door as one module sees it: claims carry the module's own id. */
export interface ToolClaims {
  claim(descriptor: ToolDescriptor, handler: ToolHandler): void;
  release(id: string): void;
}

/**
 * What `GET /tools` serves and `POST /tools` dispatches over: the
 * host's own capabilities and a module's tools meet here as equals, and the
 * OpenCode plugin registers whatever the list says at its load. The rules
 * are the task registry's: each tool id is claimed *exactly once* — a claim
 * by a second owner is a `ConfigurationError`, because the loser's tool
 * would silently not exist. The same owner re-claiming (a module restarted)
 * replaces. A call of an unclaimed id fails with the id in the reason.
 */
export class ToolRegistry {
  private readonly claims = new Map<
    string,
    { owner: string; descriptor: Omit<ServedTool, 'id'>; handler: ToolHandler }
  >();

  claim(owner: string, descriptor: ToolDescriptor, handler: ToolHandler): void {
    const parsed = toolDescriptorSchema.parse(descriptor);
    const id = `${parsed.namespace}_${parsed.name}`;
    const existing = this.claims.get(id);
    if (existing && existing.owner !== owner)
      throw new ConfigurationError(
        `Tool "${id}" is already claimed by ${existing.owner}; each tool is claimed exactly once`,
      );
    this.claims.set(id, { owner, descriptor: parsed, handler });
  }

  /** Let go of an id; afterwards a call of it fails until somebody claims it again. */
  release(owner: string, id: string): void {
    if (this.claims.get(id)?.owner === owner) this.claims.delete(id);
  }

  get(id: string): { descriptor: Omit<ServedTool, 'id'>; handler: ToolHandler } | undefined {
    return this.claims.get(id);
  }

  /** Id-sorted, what the plugin registers in order: a stable order keeps every session's prompt cache warm. */
  list(): ServedTool[] {
    return [...this.claims.entries()]
      .map(([id, claim]) => ({ id, ...claim.descriptor }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Who can do what; for status and for the day an operator asks which tool a module owns. */
  claimed(): { id: string; owner: string }[] {
    return [...this.claims.entries()].map(([id, claim]) => ({ id, owner: claim.owner }));
  }

  /** The door for one module: its id is baked in, so it cannot claim or release under another's name. */
  forModule(moduleId: string): ToolClaims {
    return {
      claim: (descriptor, handler) => this.claim(moduleId, descriptor, handler),
      release: id => this.release(moduleId, id),
    };
  }
}
