import type { ModelGatewayClient, RuntimeConfig, ToolPermissionMode, ToolRegistry } from "../../ports.js";
import type { SparkHomeService } from "../contracts.js";
import type { SparkHomeSettingsService, SparkHomeRequestSettings } from "../settings/contracts.js";
import type { SparkHomeAppearanceReference } from "../appearance-reference.js";
import type { SparkHomeAuthoringContextProvider, SparkHomeAuthoringContext } from "../authoring-context/index.js";

export type SparkHomeRunStatus = "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";
export type SparkHomeRunPhase = "plan" | "collect" | "followup" | "compose" | "publish";
export type SparkHomePendingApproval = Readonly<{
  approvalId: string; tool: string; summary: string; meta?: Readonly<Record<string, unknown>>;
}>;
export type SparkHomeRunSnapshot = Readonly<{
  runId: string; revision: number; status: SparkHomeRunStatus; phase: SparkHomeRunPhase;
  startedAt: string; updatedAt: string; screenRevision: number | null;
  pendingApproval: SparkHomePendingApproval | null; errorCode: string | null;
}>;
export type SparkHomeStartInput = Readonly<{ expectedSettingsRevision: number; instruction?: string }>;
export type SparkHomeReadRunInput = Readonly<{ runId?: string }>;
export type SparkHomeCancelInput = Readonly<{ runId: string }>;
export type SparkHomeApprovalDecisionInput = Readonly<{
  runId: string; approvalId: string; approved: boolean; reason?: string;
}>;
export type SparkHomeGenerationService = Readonly<{
  start(input: SparkHomeStartInput): Promise<SparkHomeRunSnapshot>;
  readRun(input?: SparkHomeReadRunInput): Promise<SparkHomeRunSnapshot | null>;
  cancel(input: SparkHomeCancelInput): Promise<SparkHomeRunSnapshot>;
  decideApproval(input: SparkHomeApprovalDecisionInput): Promise<SparkHomeRunSnapshot>;
  wait(runId: string): Promise<SparkHomeRunSnapshot>;
  subscribe(listener: (snapshot: SparkHomeRunSnapshot) => void): () => void;
  isIdle(): boolean;
  whenIdle(): Promise<void>;
  stop(): Promise<void>;
}>;
export type SparkHomeRunStore = Readonly<{
  read(): Promise<SparkHomeRunSnapshot | null>;
  write(snapshot: SparkHomeRunSnapshot): Promise<void>;
}>;
export type SparkHomeReadSelection = Readonly<{ operation: string; purpose: string; controls: Readonly<Record<string, unknown>> }>;
export type SparkHomePlan = Readonly<{ direction: string; reads: readonly SparkHomeReadSelection[] }>;
export type SparkHomeEvidence = Readonly<{
  operation: string; purpose: string; outcome: "succeeded" | "failed" | "rejected";
  actionFingerprint: string; output: string; omittedCharacters: number; errorCode?: string;
}>;
export type SparkHomeReadDescriptor = Readonly<{ id: string; tool: string; summary: string; input: Readonly<Record<string, unknown>> }>;
export type SparkHomeResourceReadBudgetReference = Readonly<{
  kind: "spark_home_resource_read_budget_v1"; authority: "passive_runtime_state";
  applicability: "this_home_planning_phase_only"; addsUserIntent: false; grantsActionAuthority: false;
  remainingReads: number; remainingCharacters: number; maxCharactersPerRead: number; defaultCharactersPerRead: number;
}>;
export type SparkHomeReadPlanning = Readonly<{
  operations: readonly SparkHomeReadDescriptor[]; resourceReadBudget: SparkHomeResourceReadBudgetReference;
}>;
export type SparkHomeGenerationModel = Readonly<{
  plan(input: Readonly<{ instructions: string; instruction?: string; reference: unknown }> & SparkHomeReadPlanning): Promise<SparkHomePlan>;
  followup(input: Readonly<{ instructions: string; instruction?: string; direction: string; reference: unknown; evidence: readonly SparkHomeEvidence[] }> & SparkHomeReadPlanning): Promise<SparkHomePlan>;
  html(input: Readonly<{ instructions: string; instruction?: string; direction: string; reference: string; evidence: readonly SparkHomeEvidence[] }>): Promise<string>;
}>;
export type SparkHomeGenerationDependencies = Readonly<{
  settings: Pick<SparkHomeSettingsService, "prepareRequest" | "withCalibrationReady">; screen: SparkHomeService;
  config: RuntimeConfig; models: ModelGatewayClient;
  context: SparkHomeAuthoringContextProvider; tools: ToolRegistry; store?: SparkHomeRunStore;
  getToolPermissionMode(): Promise<ToolPermissionMode>;
  getSessionId?(): Promise<string | undefined>;
  getAppearance?(): Promise<SparkHomeAppearanceReference | undefined>;
}>;
export type SparkHomeRunContext = Readonly<{
  runId: string; settings: SparkHomeRequestSettings; screenRevision: number; instruction?: string;
  sources: SparkHomeAuthoringContext; model: SparkHomeGenerationModel; signal: AbortSignal;
}>;
export class SparkHomeGenerationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "SparkHomeGenerationError"; }
}
export function homeGenerationFailure(code: string): never { throw new SparkHomeGenerationError(code); }
export function isSparkHomeRunActive(status: SparkHomeRunStatus): boolean {
  return status === "running" || status === "awaiting_approval";
}
