import type { Logger } from '@aivi/core';
import { getLogger } from '@aivi/core';
import type { PublicRequest, PublicRoutes } from '@aivi/host';
import { type LinearWebhook, verifyWebhook } from './webhook.ts';

/** An app's own stream, at `app/<id>`: agent-session events — and, for the
 * primary, the workspace's **Issues** data changes on the same route. */
export const appWebhookPath = (app: string) => `/v1/linear/webhooks/app/${app}`;

export interface WebhookApp {
  id: string;
  webhookSecret: string;
}

type Deliver = (request: PublicRequest) => Promise<{ status: number; body: unknown }>;

/** Verify, acknowledge at once (Linear retries anything but a 200), then dispatch. */
const route = (
  label: { app: string } | { endpoint: string },
  webhookSecret: string,
  dispatch: (payload: LinearWebhook) => Promise<void>,
  log: Logger,
): Deliver => {
  return async request => {
    if (request.method !== 'POST') return { status: 405, body: { error: 'Use POST' } };
    const verdict = verifyWebhook({
      body: request.body,
      signature: request.headers['linear-signature'],
      secret: webhookSecret,
    });
    const delivery = request.headers['linear-delivery'];
    if (!verdict.ok) {
      log.warn('linear.webhook.refused', { ...label, delivery, reason: verdict.reason });
      return { status: verdict.status, body: { error: verdict.reason } };
    }
    log.debug('linear.webhook', { ...label, delivery, type: verdict.payload.type, action: verdict.payload.action });
    dispatch(verdict.payload).catch(error => {
      log.warn('linear.webhook.failed', { ...label, delivery, error });
    });
    return { status: 200, body: { ok: true } };
  };
};

/**
 * One public route per app. Failures of `dispatch` are logged, never
 * returned: a retry would only replay what already failed. Bad signatures
 * are logged with the delivery id, never the body.
 */
export function registerWebhookRoutes(
  routes: PublicRoutes,
  apps: WebhookApp[],
  dispatch: (app: string, payload: LinearWebhook) => Promise<void>,
  log: Logger = getLogger(['aivi', 'linear']),
): () => void {
  const unregister = apps.map(app =>
    routes.register(
      appWebhookPath(app.id),
      route({ app: app.id }, app.webhookSecret, p => dispatch(app.id, p), log),
    ),
  );
  return () => {
    for (const off of unregister) off();
  };
}
