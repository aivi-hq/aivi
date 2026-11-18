/**
 * What the assistant's engine delivers through. A real comment the engine can
 * edit by id and delete when the answer lands is GitHub's honest stand-in for
 * Linear's ephemeral activity: the placeholder comment lives while the turn
 * runs and is gone when it ends. A run's own conversation is the tracker's
 * (`GithubPlatform.comment` edits its status comment); this is for the
 * conversations people bring us on a ticket.
 */
import type { Logger } from '@aivi/core';
import type { ChannelDelivery } from '@aivi/plugin/channel';
import type { GithubPlatform } from './tracker.ts';

export function githubDelivery(tracker: GithubPlatform, log: Logger): ChannelDelivery {
  const { client } = tracker;
  return {
    send: async (conversation, text) => {
      const id = await tracker.comment(conversation, text, 'answer');
      // The assistant's marks (D10): the rocket replaces the eyes once the
      // answer lands. A status surface only — no run state rides it, and
      // GitHub makes the pair idempotent per reactor.
      const ref = tracker.ticketOf(conversation);
      if (ref)
        await Promise.all([
          client.addReaction(ref, 'rocket').catch(error => log.warn('reaction.failed', { error })),
          client.removeOwnReaction(ref, 'eyes').catch(error => log.warn('reaction.failed', { error })),
        ]);
      return id;
    },
    placeholder: async (conversation, text) => tracker.comment(conversation, text, 'progress'),
    edit: async (conversation, id, text) => {
      const ref = tracker.ticketOf(conversation);
      if (!ref) return;
      await client.updateComment(ref, Number(id), text);
    },
    delete: async (conversation, id) => {
      const ref = tracker.ticketOf(conversation);
      if (!ref) return;
      await client.deleteComment(ref, Number(id));
    },
    notice: async (conversation, text) => {
      await tracker.comment(conversation, text, 'outcome');
    },
  };
}
