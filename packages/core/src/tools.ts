import { z } from 'zod';

/**
 * One tool as its owning module describes it and the host serves it. Nothing
 * aivi offers the model is hardcoded in the OpenCode plugin: the owner of a
 * capability contributes this descriptor, the plugin registers exactly what
 * `GET /v1/tools` answered at load. The effective id is `${namespace}_${name}`
 * — it is the permission action agent files write rules against, so it is
 * data on the owner's side and stable, never derived by the plugin.
 */
export const toolNamespaces = ['aivi', 'knowledge'] as const;

export const toolDescriptorSchema = z.strictObject({
  namespace: z.enum(toolNamespaces),
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(64),
  description: z.string().min(1).max(4096),
  /** Flat JSON Schema for the model-facing input; the claimant validates the call with its own zod schema. */
  input: z.record(z.string(), z.unknown()),
  /** The plugin's request budget: a browser action may wait 300 s behind other tabs, a status read 10 s. */
  timeoutMs: z.number().int().min(1000).max(300_000).default(10_000),
});
/** What an owner hands over at claim; the registry fills the defaults and serves the parsed form. */
export type ToolDescriptor = z.input<typeof toolDescriptorSchema>;

/** A descriptor as served, with the effective id the plugin registers and permissions match. */
export interface ServedTool extends z.output<typeof toolDescriptorSchema> {
  id: string;
}

/** Session and message ids arrive from the native tool context, never from the model. */
const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);

/** `POST /v1/tools`: run one claimed tool against the calling session. */
export const toolCallSchema = z.strictObject({
  tool: z.string().min(1).max(80),
  sessionId: identifier,
  /** The native message id; a one-off job's dedupe key rides it so a retried call creates one job, not two. */
  messageId: identifier.optional(),
  input: z.record(z.string(), z.unknown()).default({}),
});
