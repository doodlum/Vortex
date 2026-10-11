/** Options passed to deployment and its pre/post-deployment events. */
export interface IDeployOptions {
  /** Whether this deployment was explicitly requested by the user. */
  manual?: boolean;
  /** Profile associated with the requesting operation. */
  profileId?: string;
  /** Marks the final deployment performed by collection postprocessing. */
  isCollectionPostprocessCall?: boolean;
  /** Opaque session feedback request ID; omitted by callers without a status control. */
  feedbackId?: string;
}
