import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, rm } from "node:fs/promises";
import * as path from "node:path";

/** Finalize a new download without overwriting a same-named archive used by another rule. */
export async function preserveExistingDownload(
  source: string,
  destination: string,
  options: { keepSource?: boolean } = {},
): Promise<string> {
  const reserve = async (target: string) => {
    if (options.keepSource) {
      // Keep browser sources independent until the caller cleans up after a successful copy.
      await copyFile(source, target, constants.COPYFILE_EXCL);
    } else
      try {
        // Both paths are in the download folder. Hard links avoid copying large archives on NTFS.
        await link(source, target);
      } catch (err) {
        if (
          !["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(
            (err as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw err;
        await copyFile(source, target, constants.COPYFILE_EXCL);
      }
    if (!options.keepSource) await rm(source);
    return target;
  };
  try {
    return await reserve(destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const ext = path.extname(destination);
    const unique = path.join(
      path.dirname(destination),
      `${path.basename(destination, ext)}.${randomUUID()}${ext}`,
    );
    return reserve(unique);
  }
}
