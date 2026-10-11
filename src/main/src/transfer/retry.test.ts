import { VortexError } from "@vortex/shared";
import { describe, expect, it } from "vitest";

import { defaultDownloadRetryStrategy, defaultRetryStrategy } from "./retry";

describe("download response retries", () => {
  const shortResponse = () =>
    new VortexError("Network request failed", {
      kind: "http:generic",
      url: "https://example.invalid/file",
      originalCode: "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
    });

  it("keeps response retries out of the shared upload strategy", () => {
    const context = { attempt: 1, error: shortResponse() };
    expect(defaultRetryStrategy()(context)).toEqual({ retry: false });
    expect(defaultDownloadRetryStrategy()(context).retry).toBe(true);
  });

  it("limits short-response retries to three by default", () => {
    const strategy = defaultDownloadRetryStrategy();
    for (const attempt of [1, 2, 3]) {
      expect(strategy({ attempt, error: shortResponse() }).retry).toBe(true);
    }
    expect(strategy({ attempt: 4, error: shortResponse() })).toEqual({ retry: false });
  });

  it("does not retry a protocol violation even with a transient cause", () => {
    const error = new VortexError(
      "Invalid server response",
      { kind: "http:protocol-violation", url: "https://example.invalid/file" },
      { cause: shortResponse() },
    );
    expect(defaultDownloadRetryStrategy()({ attempt: 1, error })).toEqual({ retry: false });
  });
});
