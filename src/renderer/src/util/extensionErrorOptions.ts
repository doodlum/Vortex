import type { IRegisteredExtension } from "../types/extensions";
import type { IErrorOptions } from "../types/IExtensionContext";
import type { IState } from "../types/IState";
import { COMPANY_ID } from "./constants";

/**
 * The options `api.showErrorNotification` gives an error before showing it: the
 * third-party extension it came from - the calling one, or the one the error names in
 * `details.extension` - so its details can offer a Report to that extension's tracker and
 * say whom to report it to. Anything that shows an error without that notification uses
 * this to say the same.
 */
export function extensionErrorOptions(
  caller: IRegisteredExtension | undefined,
  loaded: () => IRegisteredExtension[],
  state: IState,
  details: unknown,
  options?: IErrorOptions,
): IErrorOptions | undefined {
  let extension = caller;
  const named = (details as { extension?: string } | undefined)?.extension;

  if (extension === undefined && named !== undefined) {
    extension = loaded().find((iter) => iter.name === named);
  }

  if (extension?.info === undefined || extension.info.author === COMPANY_ID) {
    return options;
  }

  // filled in place, as showErrorNotification always did
  const result: IErrorOptions = options ?? {};
  if (result.allowReport !== false) {
    result.extensionName = extension.info.name;
    const info = extension.info;
    result.extensionRemote = state.session.extensions.available.find((ext) =>
      info.modId !== undefined ? info.modId === ext.modId : info.name === ext.name,
    );
  }
  result.extension = extension;
  return result;
}
