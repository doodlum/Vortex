import type { ILookupResult, IModInfo } from "modmeta-db";

import type { IDownloadHint, IMod, IModInstallSpec, IModReference, IModRuleExtra } from "./IMod";

export interface IModInfoEx extends IModInfo {
  referer?: string | (() => PromiseLike<string>);
  sourceURI: string | (() => PromiseLike<string>);
}

export interface ILookupResultEx extends ILookupResult {
  value: IModInfoEx;
}

// a resolved mod rule: the install spec (IModInstallSpec) plus reference / phase / extra,
// with the runtime resolution fields (download / lookupResults / mod) filled in while
// gathering dependencies. Mirrors the install-relevant fields of IModRule, minus the rule
// machinery (IRule's `type`, ignored). Retain the download hint so a rejected local archive
// can resolve its replacement source without prompting while valid bytes are reused.
export interface IDependency extends IModInstallSpec {
  download: string;
  reference: IModReference;
  lookupResults: ILookupResultEx[];
  downloadHint?: IDownloadHint;
  mod?: IMod;
  phase?: number;
  extra?: IModRuleExtra;
  sessionRuleId?: string;
}

export interface IDependencyError {
  error: string;
}

export type Dependency = IDependency | IDependencyError;
