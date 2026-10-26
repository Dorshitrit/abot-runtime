import type { ToolPermissionMode } from "./tool-permission-mode.js";

/** Trusted host context for a tool-owned, side-effect-free execution preflight. */
export type ToolExecutionBindingContext = Readonly<{
  toolPermissionMode: ToolPermissionMode;
  sessionId?: string;
  abortSignal?: AbortSignal;
}>;

export type ToolExecutionBinding = Readonly<{
  identity: string;
  /** Human disclosure only; never model controls or tool-result evidence. */
  metadata?: Readonly<Record<string, unknown>>;
  /** Additional explicit approval, including in FULL+. Cannot weaken host policy. */
  requiresApproval?: boolean;
}>;

/** Captured by the host and delivered only after the required approval succeeds. */
export type ToolExecutionAuthority = Readonly<{
  toolPermissionMode: ToolPermissionMode;
  executionIdentity?: string;
}>;
