import { getErrorMessageOrDefault } from "@vortex/shared";

/**
 * Community game extensions commonly reject discovery when their launcher or
 * registry integration is unavailable on the current platform. That is a
 * normal discovery miss, not an extension failure.
 */
export function isExpectedDiscoveryMiss(err: unknown, platform = process.platform): boolean {
  const message = getErrorMessageOrDefault(err);

  if (/install path not found/i.test(message)) {
    return true;
  }

  return (
    platform !== "win32" &&
    (/only discovered on windows/i.test(message) ||
      /not available on (?:this|the current) platform/i.test(message) ||
      /no supported game store.*on (?:this|the current) platform/i.test(message) ||
      /winapi\.[A-Za-z0-9_$]+ is not a function/i.test(message))
  );
}
