import { NOOP_VIEWER_LIFECYCLE, ViewerLifecycleObserver } from "./ViewerLifecycleObserver";

/** The sole compile-time QA replacement seam; no runtime switch or debug endpoint. */
export function createViewerLifecycleObserver(): ViewerLifecycleObserver {
  return NOOP_VIEWER_LIFECYCLE;
}
