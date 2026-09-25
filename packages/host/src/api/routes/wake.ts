import type { Hono } from 'hono';
import type { AppEnv } from '../env.ts';

/** `POST /wake`: the CLI changed the queue in SQLite; dispatch now. */
export function registerWake(app: Hono<AppEnv>, deps: { wake?: (() => void) | undefined }): void {
  app.post('/wake', c => {
    deps.wake?.();
    return c.json({ woken: deps.wake !== undefined });
  });
}
