/** Standard settled outcomes with either the native or legacy renderer Promise implementation. */
export async function settleAll<T>(
  promises: Iterable<T | PromiseLike<T>>,
): Promise<PromiseSettledResult<Awaited<T>>[]> {
  return Promise.all(
    Array.from(promises, (promise) =>
      Promise.resolve(promise).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
    ),
  );
}
