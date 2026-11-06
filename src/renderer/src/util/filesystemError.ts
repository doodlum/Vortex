import { constants } from "node:os";

import { getErrorCode } from "@vortex/shared";

/** libuv may omit EDQUOT's name while preserving the kernel errno. */
export function getFilesystemErrorCode(error: unknown): string | null {
  const code = getErrorCode(error);
  if (
    process.platform === "linux" &&
    error instanceof Error &&
    "errno" in error &&
    typeof constants.errno.EDQUOT === "number" &&
    error.errno === -constants.errno.EDQUOT &&
    (code === "UNKNOWN" || code === `Unknown system error ${error.errno}`)
  ) {
    return "EDQUOT";
  }
  return code;
}
