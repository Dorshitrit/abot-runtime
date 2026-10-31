import type { ConversationToolAction } from "../lib/tool-activity-model.js";

export declare function createConversationToolEvidence(
  action: Pick<
    ConversationToolAction,
    "sent" | "received" | "target" | "executed" | "preview"
  >,
  options?: { documentRoot?: Document; hideRepeatedTarget?: boolean; createFileChanges?(excerpt: HTMLElement | null): HTMLElement | null },
): HTMLElement | null;
