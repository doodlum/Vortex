import { UserCanceled } from "./CustomErrors";

export function throwIfDownloadCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new UserCanceled(false);
}

/** Stop awaiting a resolver even when its underlying API cannot abort the request. */
export function withDownloadCancellation<T>(
  work: () => PromiseLike<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new UserCanceled(false));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      Promise.resolve(work())
        .then(resolve, reject)
        .finally(() => {
          signal?.removeEventListener("abort", abort);
        });
    } catch (err) {
      signal?.removeEventListener("abort", abort);
      reject(err);
    }
  });
}

export function waitForDownloadRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UserCanceled(false));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new UserCanceled(false));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
