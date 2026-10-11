export interface IResolvedURL {
  urls: string[];
  updatedUrl?: string;
  meta: any;
}

export interface IResolvedURLs {
  urls: string[];
  updatedUrls?: string[];
  meta: any;
}

/** Download handlers can stop network work when their owning resolution is abandoned. */
export type DownloadProtocolHandler = (
  inputUrl: string,
  name?: string,
  friendlyName?: string,
  signal?: AbortSignal,
) => PromiseLike<{ urls: string[]; updatedUrl?: string; meta: unknown }>;

export interface IProtocolHandlers {
  [scheme: string]: DownloadProtocolHandler;
}
