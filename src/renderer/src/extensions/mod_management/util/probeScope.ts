/**
 * Share filesystem probes within one synchronous support check.
 *
 * getCurrentActivator asks a deployment method's isSupported once per mod type, and twice over
 * when it has to pick a default. A method's probe of the staging folder (hard link canary) then
 * runs back to back with the same inputs and nothing else in between. Inside a scope, a probe
 * with the same key runs once and the later calls reuse its result. Nothing is kept once the
 * outermost scope returns, so separate calls probe again as they did before.
 */

let activeScope: Map<string, unknown> | undefined;

/** run `func` with probes shared; nested scopes join the outer one */
export function withProbeScope<T>(func: () => T): T {
  if (activeScope !== undefined) {
    return func();
  }
  activeScope = new Map();
  try {
    return func();
  } finally {
    activeScope = undefined;
  }
}

/**
 * run `probe` for `key` or reuse a result from earlier in the current scope. Outside a scope it
 * always runs. A result for which `reusable` returns false is not shared.
 */
export function scopedProbe<T>(key: string, probe: () => T, reusable: (result: T) => boolean): T {
  if (activeScope?.has(key)) {
    return activeScope.get(key) as T;
  }
  const result = probe();
  if (activeScope !== undefined && reusable(result)) {
    activeScope.set(key, result);
  }
  return result;
}
