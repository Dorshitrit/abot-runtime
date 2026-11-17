import type { AgentMode } from "./runtime-selection-controller.js";
import type { ModelReasoningPreference } from "../../../shared/model-reasoning.js";
import type { SessionModelSelection } from "../../../sessions/model-selection.js";

export type RunSelectionScope = { environmentId: string; sessionId: string; viewVersion?: number };
export type PendingRunSelection = { profileId?: string; agentMode?: AgentMode; reasoningPreference?: ModelReasoningPreference; requestId?: string };

export declare function createSessionRunSelection(dependencies: {
  getScope(): RunSelectionScope;
  getComposerScope(): RunSelectionScope;
  isHome?(): boolean;
  getRequestGeneration?(requestId: string): string | undefined;
  hasUnsentDraft?(scope: RunSelectionScope): boolean;
  getSubmissionScopes?(): Iterable<RunSelectionScope>;
}): {
  run(): SessionModelSelection | null;
  override(): PendingRunSelection | null;
  remember(fields: PendingRunSelection): void;
  applySnapshot(payload: Record<string, unknown>, scope: RunSelectionScope): boolean;
  observeEvent(message: Record<string, unknown>): boolean;
  reasoningRun(profileId: string): SessionModelSelection | null;
  clear(): void;
  pruneEmptyDraftSelections(scope?: RunSelectionScope): boolean;
  retireSessionSelection(scope: RunSelectionScope): boolean;
  selectedProfileId(fallback?: string): string | undefined;
  profileIdForSession(scope: RunSelectionScope, fallback: string): string;
  selectedAgentMode(fallback: AgentMode): AgentMode;
  selectedReasoningPreference(profileId: string, fallback?: ModelReasoningPreference): ModelReasoningPreference | undefined;
};
