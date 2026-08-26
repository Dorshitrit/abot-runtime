import type { SessionThinkingTraceStatus } from "../../sessions/types.js";

export type RuntimeThinkingTrace = {
  step: string;
  status: SessionThinkingTraceStatus;
  text: string;
};
