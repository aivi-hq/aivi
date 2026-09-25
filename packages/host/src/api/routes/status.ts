import type { LoadedConfig, ModuleHealth } from '@aivi/core';
import type { Hono } from 'hono';
import type { Store } from '../../store.ts';
import type { AppEnv } from '../env.ts';
import { status } from '../status.ts';

export function registerStatus(
  app: Hono<AppEnv>,
  deps: { store: Store; loaded: LoadedConfig; health?: (() => ModuleHealth[]) | undefined },
): void {
  app.get('/status', c => c.json(status(deps.store, deps.loaded, Date.now(), deps.health?.() ?? [])));
}
