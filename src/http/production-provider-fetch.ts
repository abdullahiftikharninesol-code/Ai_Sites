/** Existing client deadlines are preserved; the lifecycle deadline also aborts transport/body reads. */
export function productionProviderFetch(signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    signal.throwIfAborted();
    const prior = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return globalThis.fetch(input, { ...init, signal: prior ? AbortSignal.any([signal, prior]) : signal });
  };
}
