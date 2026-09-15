/**
 * What a knowledge source contains. This is the single registry of kinds: the
 * librarian sees these descriptions and search can filter by kind. Add a kind
 * here when a new class of material appears. Dependency-free so the OpenCode
 * plugin can import it without pulling in the config machinery.
 */
export const knowledgeKinds = {
  doc: { description: 'Reference material: handbooks, guides, research notes. Relevant whenever the topic matches.' },
  decision: {
    description:
      'Recorded decisions (ADRs). Authoritative for why something is the way it is; cite them over inference.',
  },
  memory: {
    description:
      'Facts and proposals distilled from conversations by dreaming. Dated and attributed; softer than docs and decisions.',
  },
  conversation: {
    description: 'Indexed conversation transcripts. Useful for recovering details; never authoritative.',
  },
} as const;
export type KnowledgeKind = keyof typeof knowledgeKinds;
export const knowledgeKindNames = Object.keys(knowledgeKinds) as [KnowledgeKind, ...KnowledgeKind[]];
export const knowledgeKindHelp = knowledgeKindNames.map(k => `${k}: ${knowledgeKinds[k].description}`).join(' ');
