export type { ModelStep } from "./model-steps.js";

export type AgentMode = "fast" | "reasoning" | "deep";

export type ModelReasoningLevel =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type OutboundBridgeMessage =
  | { type: "completed"; requestId: string; output: string }
  | { type: "failed"; requestId: string; error: string }
  | { type: "event"; requestId: string; name: string; [key: string]: unknown };
