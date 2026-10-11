import { once } from "node:events";
import { type FileHandle as NodeFileHandle, access, open } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";

import { getErrorCode } from "@vortex/shared";
import { VortexError, parseError } from "@vortex/shared";
import type {
  ByteRange,
  Chunk,
  Chunker,
  ChunkProgress,
  ResolvedEndpoint,
  Resolver,
  RetryStrategy,
} from "@vortex/shared/download";
import type { Got, Headers, ExtendOptions, Response } from "got";
import got from "got";
import type { RateLimiter } from "limiter";
import PQueue from "p-queue";
import type { CookieJar } from "tough-cookie";

import { isCancellation } from "../transfer/cancellation";
import { withRetry } from "../transfer/retry";
import type { TimeoutOptions } from "../transfer/timeouts";
import { createGotTimeoutOptions } from "../transfer/timeouts";
import { toNetworkError } from "./errors";
import type { ProgressReporter } from "./progress";
import type { NormalizedResource } from "./resolver";
import { normalize } from "./resolver";

export const defaultChunkConcurrency = 4;

/** @internal */
export type Checkpoint = {
  etag: string | undefined;
  completedRanges: ByteRange[];
};

export type { TimeoutOptions };

/** @internal */
export async function download<T>(
  resource: T,
  dest: string,
  strategy: {
    resolver: Resolver<T>;
    chunker: Chunker<T>;
    rateLimiter?: RateLimiter;
    retry?: RetryStrategy;
  },
  options?: {
    cookieJar?: CookieJar;
    progressReporter?: ProgressReporter;
    abortSignal?: AbortSignal;
    chunkConcurrency?: number;
    checkpoint?: Checkpoint;
    timeout?: TimeoutOptions;
    userAgent?: string;
  },
): Promise<void> {
  if (options?.abortSignal?.aborted) {
    throw new VortexError("Download cancelled", { kind: "user-canceled", skipped: false });
  }

  // Resuming opens the partial file with r+, which requires it to exist; drop the checkpoint when
  // that file is missing so the download starts fresh.
  let checkpoint = options?.checkpoint;
  if (checkpoint !== undefined) {
    try {
      await access(dest);
    } catch (err) {
      // Only a missing file (ENOENT) invalidates the checkpoint; any other access error is left for
      // open() below to surface.
      if (getErrorCode(err) === "ENOENT") {
        checkpoint = undefined;
      }
    }
  }

  const stopController = new AbortController();
  const abortSignal = options?.abortSignal
    ? AbortSignal.any([options.abortSignal, stopController.signal])
    : stopController.signal;

  const sessionGot = got.extend({
    cookieJar: options?.cookieJar,
    signal: abortSignal,
    timeout: createGotTimeoutOptions(options?.timeout),
    retry: { limit: 0 },
    // Archive offsets/counts describe the identity representation. Avoid got's
    // decompression byte observer consuming a response during cookie handling.
    decompress: false,
    headers: {
      "User-Agent": options?.userAgent,
      "Accept-Encoding": "identity",
    },
  } satisfies ExtendOptions);

  let resolved: NormalizedResource;
  try {
    resolved = normalize(await strategy.resolver(resource));
    abortSignal.throwIfAborted();
  } catch (err) {
    if (isCancellation(err)) {
      throw new VortexError(
        "Download cancelled",
        { kind: "user-canceled", skipped: false },
        { cause: err },
      );
    }
    throw new VortexError("Resolver failed", { kind: "download:resolver-error" }, { cause: err });
  }

  let probe: ProbeResult;
  try {
    probe = await withRetry(
      () => probeUrl(sessionGot, resolved.probeEndpoint, checkpoint?.etag ?? undefined),
      strategy.retry,
      abortSignal,
    );
  } catch (err) {
    if (isCancellation(err)) {
      throw new VortexError(
        "Download cancelled",
        { kind: "user-canceled", skipped: false },
        { cause: err },
      );
    }

    throw toNetworkError(resolved.probeEndpoint, err);
  }

  // A full response cannot be appended to a range checkpoint. Start with a
  // truncated file when the probe cannot establish usable range support/size.
  if (!probe.acceptsRanges || probe.size === undefined || probe.size === 0) checkpoint = undefined;

  if (options?.progressReporter) {
    if (probe.etag) options.progressReporter.etag = probe.etag;
    if (probe.fileName) options.progressReporter.fileName = probe.fileName;
  }

  const chunks: Chunk[] =
    probe.acceptsRanges && probe.size
      ? await Promise.resolve(strategy.chunker(probe.size, resource))
      : [];
  const isChunked = chunks.length > 1;

  let completedRanges = checkpoint?.completedRanges ?? [];
  let pendingChunks = chunks.filter(
    (chunk) =>
      !completedRanges.some((r) => r.start <= chunk.range.start && r.end >= chunk.range.end),
  );

  let handle: FileHandle;

  try {
    // https://nodejs.org/api/fs.html#file-system-flags
    // 'w+': Open file for reading and writing. The file is created (if it does not exist) or truncated (if it exists).
    // 'r+': Open file for reading and writing. An exception occurs if the file does not exist.
    const flag = checkpoint ? "r+" : "w+";
    const fd = await open(dest, flag);
    handle = { fd, path: dest };
  } catch (err) {
    throw parseError(err, { path: dest }, () => `Failed to open ${dest}`);
  }

  try {
    abortSignal.throwIfAborted();
    if (checkpoint) {
      const actual = await handle.fd.stat();
      const missingRange = completedRanges.some(
        (range) =>
          !Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.end) ||
          range.start < 0 ||
          range.end < range.start ||
          range.end >= actual.size ||
          (probe.size !== undefined && range.end >= probe.size),
      );
      if (missingRange) {
        // A persisted checkpoint cannot invent bytes missing from the partial file.
        checkpoint = undefined;
        completedRanges = [];
        pendingChunks = chunks;
        await handle.fd.truncate(0);
      }
    }
    if (checkpoint && probe.size) {
      try {
        await handle.fd.truncate(probe.size);
      } catch (err) {
        throw parseError(err, { path: handle.path }, () => `Failed to truncate ${handle.path}`);
      }
    }

    if (isChunked) {
      const chunkQueue = new PQueue({
        concurrency: options?.chunkConcurrency ?? defaultChunkConcurrency,
      });

      let chunkProgress: Map<number, ChunkProgress> | undefined = undefined;
      if (options?.progressReporter) {
        chunkProgress = options.progressReporter.initChunked(chunks, probe.size!);

        // fast forward progress reporter to checkpoint
        for (const chunk of chunks) {
          const isComplete = completedRanges.some(
            (r) => r.start <= chunk.range.start && r.end >= chunk.range.end,
          );
          if (isComplete) {
            const progress = chunkProgress.get(chunk.index);
            if (!progress) continue;
            const size = chunk.range.end - chunk.range.start + 1;
            progress.bytesReceived = size;
            progress.bytesWritten = size;
          }
        }
      }

      let failure: { error: unknown } | undefined;
      // Queue signals race active tasks into early settlement. Abort their actual
      // work instead, then drain every submitted task before releasing the file.
      const workers = pendingChunks.map((chunk) =>
        chunkQueue.add(async () => {
          try {
            abortSignal.throwIfAborted();
            await withRetry(
              () => {
                abortSignal.throwIfAborted();
                const progress = chunkProgress?.get(chunk.index);
                if (progress) {
                  progress.bytesReceived = 0;
                  progress.bytesWritten = 0;
                }
                return downloadChunk(sessionGot, chunk, resolved, probe, handle, {
                  abortSignal,
                  rateLimiter: strategy.rateLimiter,
                  progress,
                });
              },
              strategy.retry,
              abortSignal,
            );
          } catch (error) {
            failure ??= { error };
            stopController.abort();
            throw error;
          }
        }),
      );
      await Promise.allSettled(workers);
      if (failure) throw failure.error;
    } else {
      // Compute the checkpoint baseline: the contiguous byte position
      // that was already completed before this download call. On retry
      // we reset back to this position rather than to zero, because
      // those bytes are already valid on disk.
      let checkpointPosition = 0;

      if (checkpoint && completedRanges.length > 0) {
        const sortedRanges = completedRanges.toSorted((a, b) => a.start - b.start);

        let currentEnd = -1;

        for (const range of sortedRanges) {
          if (range.start === currentEnd + 1) {
            currentEnd = range.end;
          } else if (range.start === 0) {
            currentEnd = range.end;
          } else {
            break;
          }
        }

        checkpointPosition = currentEnd + 1;
      }

      const progress = options?.progressReporter?.init(probe.size);

      await withRetry(
        async () => {
          abortSignal.throwIfAborted();
          // Publish only the retained prefix before shrinking the file: pause
          // can arrive while the physical truncate itself is still pending.
          if (progress) {
            progress.bytesReceived = checkpointPosition;
            progress.bytesWritten = checkpointPosition;
          }

          // A shorter successful retry must not retain a failed attempt's suffix.
          // Keep only the checkpoint's already verified contiguous prefix.
          try {
            await handle.fd.truncate(checkpointPosition);
          } catch (err) {
            throw parseError(err, { path: handle.path }, () => `Failed to truncate ${handle.path}`);
          }
          abortSignal.throwIfAborted();
          // Reset write position and progress back to the checkpoint
          // baseline on every attempt. Any bytes written by a previous
          // failed attempt will be overwritten.
          const writePosition = checkpointPosition;

          let expectedRemainingBytes: number | undefined = probe.size
            ? probe.size - writePosition
            : undefined;
          let rangeChunk: Chunk | undefined = undefined;

          if (probe.size && writePosition > 0) {
            expectedRemainingBytes = probe.size - writePosition;
          }

          // When the server supports range requests, use a Range header
          // even in the non-chunked path. This avoids re-downloading
          // already-completed bytes when resuming and lets the server
          // send only the remainder of the file.
          if (probe.acceptsRanges && probe.size && writePosition > 0) {
            rangeChunk = {
              index: 0,
              range: { start: writePosition, end: probe.size - 1 },
            };
            expectedRemainingBytes = probe.size - writePosition;
          }

          if (probe.size !== undefined && writePosition === probe.size && checkpointPosition > 0) {
            return Promise.resolve();
          }

          return downloadStream(sessionGot, resolved.probeEndpoint, handle, writePosition, {
            progress: progress,
            abortSignal,
            rateLimiter: strategy.rateLimiter,
            etag: probe.etag ?? undefined,
            chunk: rangeChunk ?? undefined,
            expectedRemainingBytes,
            expectedTotalBytes: probe.size || undefined,
          });
        },
        strategy.retry,
        abortSignal,
      );
    }
  } catch (err) {
    if (isCancellation(err)) {
      throw new VortexError(
        "Download cancelled",
        { kind: "user-canceled", skipped: false },
        { cause: err },
      );
    }

    throw err;
  } finally {
    await handle.fd.close();
  }
}

async function probeUrl(
  got: Got,
  endpoint: ResolvedEndpoint,
  previousETag: string | undefined,
): Promise<ProbeResult> {
  const response = await got.head(endpoint.url, {
    headers: createHeaders(previousETag, undefined, endpoint.headers),
  });

  const contentType = response.headers["content-type"] ?? "";
  if (contentType.startsWith("text/html")) {
    throw new VortexError("Server returned an HTML page instead of a file", {
      kind: "download:is-html",
      url: endpoint.url.toString(),
    });
  }

  const size = getSize(response.headers, "content-length");

  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Accept-Ranges
  // NOTE(erri120): only valid range units are "bytes" and "none"
  // https://www.iana.org/assignments/http-parameters/http-parameters.xhtml#range-units
  const acceptsRanges = response.headers["accept-ranges"] === "bytes";

  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag
  const encoding = response.headers["content-encoding"];
  if (encoding && encoding !== "identity")
    throw new VortexError("Server returned an encoded archive representation", {
      kind: "http:protocol-violation",
      url: endpoint.url.toString(),
    });
  const etag = response.headers.etag;

  // NOTE(erri120): Server has to do the precondition check of the ETag.
  if (etag && previousETag && etag !== previousETag) {
    throw new VortexError("ETag has changed, server didn't validate precondition", {
      kind: "http:protocol-violation",
      url: endpoint.url.toString(),
    });
  }

  const fileName =
    getContentDispositionFileName(response.headers) ?? getFileNameFromUrl(endpoint.url.toString());

  return { size, acceptsRanges, etag, fileName };
}

/**
 * Create a got stream with an immediate no-op error listener.
 *
 * got internally calls `this.destroy(new AbortError())` inside an
 * `abort` event listener on the signal.  If the stream has no `error`
 * listener at that moment Node promotes the error to an uncaught
 * exception.  Attaching a no-op listener here prevents that;
 * downstream consumers still receive the error
 * through their own mechanisms.
 */
function createGotStream(
  got: Got,
  endpoint: ResolvedEndpoint,
  options: {
    etag?: string;
    chunk?: Chunk;
  },
) {
  const stream = got.stream(endpoint.url, {
    headers: createHeaders(options?.etag, options?.chunk, endpoint.headers),
  });

  stream.on("error", () => {});

  return stream;
}

async function consumeTokens(
  limiter: RateLimiter,
  bytes: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  let remaining = bytes;
  while (remaining > 0) {
    abortSignal?.throwIfAborted();
    const toRemove = Math.min(remaining, limiter.tokenBucket.bucketSize);
    const delay = limiter.removeTokens(toRemove);
    await delay;
    abortSignal?.throwIfAborted();
    remaining -= toRemove;
  }
}

async function downloadStream(
  got: Got,
  endpoint: ResolvedEndpoint,
  handle: FileHandle,
  writePosition: number,
  options: {
    progress?: { bytesReceived: number; bytesWritten: number };
    abortSignal?: AbortSignal;
    rateLimiter?: RateLimiter;
    etag?: string;
    chunk?: Chunk;
    expectedRemainingBytes?: number;
    expectedTotalBytes?: number;
  },
): Promise<void> {
  const { progress } = options;
  options.abortSignal?.throwIfAborted();
  const stream = createGotStream(got, endpoint, {
    etag: options.etag,
    chunk: options.chunk,
  });

  let remaining = options.expectedRemainingBytes;

  try {
    // Node events are untyped; got emits its Response object on this event.
    const [response] = (await once(stream, "response")) as [Response];
    validateResponse(response, endpoint, options);
    for await (const data of stream) {
      const buffer = data as Buffer;
      if (progress) progress.bytesReceived += buffer.length;

      if (remaining !== undefined) {
        if (buffer.length > remaining) {
          throw new VortexError(
            `Server sent ${buffer.length} bytes but only ${remaining} were expected; response exceeds requested range`,
            { kind: "http:protocol-violation", url: endpoint.url.toString() },
          );
        }
        remaining -= buffer.length;
      }

      if (options.rateLimiter) {
        await consumeTokens(options.rateLimiter, buffer.length, options.abortSignal);
      }

      options.abortSignal?.throwIfAborted();
      try {
        let offset = 0;
        while (offset < buffer.length) {
          options.abortSignal?.throwIfAborted();
          const result = await handle.fd.write(
            buffer,
            offset,
            buffer.length - offset,
            writePosition,
          );
          if (result.bytesWritten === 0) throw new Error("File write made no progress");
          offset += result.bytesWritten;
          if (progress) progress.bytesWritten += result.bytesWritten;
          writePosition += result.bytesWritten;
        }
      } catch (err) {
        if (isCancellation(err)) throw err;
        throw parseError(err, { path: handle.path }, () => `Failed to write to ${handle.path}`);
      }
    }
    options.abortSignal?.throwIfAborted();
    if (remaining !== undefined && remaining !== 0) {
      throw new VortexError("Server sent fewer bytes than requested", {
        kind: "http:protocol-violation",
        url: endpoint.url.toString(),
      });
    }
  } catch (err) {
    if (err instanceof VortexError || isCancellation(err)) throw err;
    throw toNetworkError(stream.requestUrl ?? endpoint.url, err);
  } finally {
    stream.destroy();
  }
}

function validateResponse(
  response: { statusCode: number; headers: IncomingHttpHeaders },
  endpoint: ResolvedEndpoint,
  options: {
    chunk?: Chunk;
    etag?: string;
    expectedTotalBytes?: number;
    expectedRemainingBytes?: number;
  },
): void {
  const invalid = () =>
    new VortexError("Server response does not match the requested resource range", {
      kind: "http:protocol-violation",
      url: endpoint.url.toString(),
    });
  const encoding = response.headers["content-encoding"];
  if (encoding && encoding !== "identity") throw invalid();
  const etag = response.headers.etag;
  if (etag && options.etag && etag !== options.etag) throw invalid();
  if (options.chunk) {
    // RFC 9110 sections 14.4 and 15.3.7.1: a 206 is self-descriptive.
    // Never treat a full or different partial representation as this chunk.
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers["content-range"] ?? "");
    if (
      response.statusCode !== 206 ||
      !match ||
      Number(match[1]) !== options.chunk.range.start ||
      Number(match[2]) !== options.chunk.range.end ||
      (options.expectedTotalBytes !== undefined && Number(match[3]) !== options.expectedTotalBytes)
    )
      throw invalid();
  } else if (response.statusCode !== 200) {
    throw invalid();
  }
  const length = getSize(response.headers, "content-length");
  if (
    length !== undefined &&
    options.expectedRemainingBytes !== undefined &&
    length !== options.expectedRemainingBytes
  )
    throw invalid();
}

async function downloadChunk(
  got: Got,
  chunk: Chunk,
  resource: NormalizedResource,
  probe: ProbeResult,
  handle: FileHandle,
  options: {
    progress?: ChunkProgress;
    rateLimiter?: RateLimiter;
    abortSignal?: AbortSignal;
  },
): Promise<void> {
  options.abortSignal?.throwIfAborted();

  const endpoint = await resource.chunkEndpoint(chunk);
  options.abortSignal?.throwIfAborted();
  const expectedRemainingBytes = chunk.range.end - chunk.range.start + 1;

  await downloadStream(got, endpoint, handle, chunk.range.start, {
    chunk,
    expectedRemainingBytes,
    expectedTotalBytes: probe.size || undefined,
    etag: probe.etag,
    progress: options.progress,
    rateLimiter: options.rateLimiter,
    abortSignal: options.abortSignal,
  });
}

function createHeaders(
  etag: string | undefined,
  chunk: Chunk | undefined,
  additionalHeaders?: Record<string, string>,
): Headers {
  const range = chunk ? `bytes=${chunk.range.start}-${chunk.range.end}` : undefined;

  // Weak ETags MUST NOT be used with preconditions. The "W/" prefix is case sensitive.
  // https://www.rfc-editor.org/rfc/rfc9110#name-etag
  const isStrongETag = etag && !etag.startsWith("W/");
  const ifMatch = isStrongETag ? etag : undefined;

  return {
    Range: range,
    "If-Match": ifMatch,
    ...(additionalHeaders ?? {}),
  };
}

function getSize(
  headers: IncomingHttpHeaders,
  header: "content-length" | "content-range",
): number | undefined {
  const rawValue = headers[header];
  if (!rawValue) return undefined;

  let parsed: number | undefined;
  if (header === "content-length") {
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Length
    // Content-Length: <length>
    parsed = parseInt(rawValue, 10);
  } else if (header === "content-range") {
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Range
    // Content-Range: <unit> <range>/<size>
    // Content-Range: <unit> <range>/*
    // Content-Range: <unit> */<size>
    const slashIndex = rawValue.lastIndexOf("/");
    if (slashIndex === -1) return undefined;

    const size = rawValue.slice(slashIndex + 1);
    if (size === "*") return undefined;

    parsed = parseInt(size, 10);
  }

  if (parsed === undefined || parsed < 0 || isNaN(parsed)) return undefined;
  return parsed;
}

function getContentDispositionFileName(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers["content-disposition"];
  if (!raw) return undefined;
  // RFC 6266: filename* (encoded) takes priority over filename.
  const starMatch = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(raw);
  if (starMatch && starMatch[1]) {
    try {
      return decodeURIComponent(starMatch[1].trim());
    } catch {
      // fall through to plain filename
    }
  }

  const plainMatch = /filename\s*=\s*"?([^";]+)"?/i.exec(raw);
  return plainMatch && plainMatch[1] ? plainMatch[1].trim() : undefined;
}

function getFileNameFromUrl(url: string): string | undefined {
  try {
    const basename = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
    return basename.length > 0 ? basename : undefined;
  } catch {
    return undefined;
  }
}

type ProbeResult = {
  size: number | undefined;
  acceptsRanges: boolean;
  etag: string | undefined;
  fileName: string | undefined;
};

type FileHandle = { fd: NodeFileHandle; path: string };
