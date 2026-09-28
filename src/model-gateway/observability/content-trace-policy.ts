import { containsRequestToolMedia } from "./tool-media-privacy.js";

/** Short-lived observations never enter raw model input/output logs. */
export function permitsModelContentTrace(modelStep: unknown, input?: unknown): boolean {
  if (modelStep === "learning.batch") return false;
  return !containsRequestToolMedia(input);
}
