import type { Logger } from '@aivi/core';
import { silentLogger } from '@aivi/core';
import type { PublicRequest, PublicRoutes } from '@aivi/host';
import { type LinearWebhook, verifyWebhook } from './webhook.ts';

export const webhookPath = (app: string) => `/v1/linear/webhooks/${app}`;

export interface WebhookApp {
  id: string;
  webhookSecret: string;
}

/**
 * One public route per app on the host listener. A delivery is verified,
 * acknowledged at once (Linear allows five seconds and retries on anything
 * but a 200) and then handed to `dispatch`, whose failures are logged, never
 * returned: a retry would only replay what already failed. Bad signatures are
 * logged with the delivery id, never the body.
 */
export function registerWebhookRoutes(
  routes: PublicRoutes,
  apps: WebhookApp[],
  dispatch: (app: string, payload: LinearWebhook) => Promise<void>,
  log: Logger = silentLogger,
): () => void {
  const unregister = apps.map(app =>
    routes.register(webhookPath(app.id), async (request: PublicRequest) => {
      if (request.method !== 'POST') return { status: 405, body: { error: 'Use POST' } };
      const verdict = verifyWebhook({
        body: request.body,
        signature: request.headers['linear-signature'],
        secret: app.webhookSecret,
      });
      const delivery = request.headers['linear-delivery'];
      if (!verdict.ok) {
        log.warn('linear.webhook.refused', { app: app.id, delivery, reason: verdict.reason });
        return { status: verdict.status, body: { error: verdict.reason } };
      }
      log.debug('linear.webhook', {
        app: app.id,
        delivery,
        type: verdict.payload.type,
        action: verdict.payload.action,
      });
      dispatch(app.id, verdict.payload).catch(error => {
        log.warn('linear.webhook.failed', { app: app.id, delivery, error });
      });
      return { status: 200, body: { ok: true } };
    }),
  );
  return () => {
    for (const off of unregister) off();
  };
}
