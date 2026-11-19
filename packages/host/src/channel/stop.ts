/** One module's stop: see `stopSwitch`. */
export interface StopSwitch {
  /** Aborted when the module stops: what its event handlers ask before they act. */
  readonly signal: AbortSignal;
  /** End what the module does on its own, and stop its engine if it has built one. */
  stop(): void;
  /** Take the switch off the host's shutdown signal: the last step of a teardown. */
  release(): void;
}

/**
 * The stop every module that runs a channel engine holds: one switch that
 * aborts `signal` and stops the engine the module builds once it is
 * connected — a getter, because the engine does not exist yet when the
 * switch is made. The host's shutdown signal throws the switch, once, until
 * `release` takes the hook off.
 */
export function stopSwitch(host: AbortSignal, engine: () => { stop(): void } | undefined): StopSwitch {
  const abort = new AbortController();
  const stop = (): void => {
    abort.abort();
    engine()?.stop();
  };
  host.addEventListener('abort', stop, { once: true });
  return { signal: abort.signal, stop, release: () => host.removeEventListener('abort', stop) };
}
