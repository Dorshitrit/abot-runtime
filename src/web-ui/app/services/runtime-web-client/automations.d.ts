import type { AutomationRevision, OperationRef } from "../../../../runtime/automations/definition-contracts.js";

export type AutomationDraftResponse = Readonly<{
  draft: Readonly<{ automationId: string; revision: number; definition: AutomationRevision; archivedAt?: string }>;
  grant?: Record<string, unknown> | null;
  validation?: Record<string, unknown> | null;
}>;

export type AutomationRunHistoryQuery = Readonly<{
  limit?: number;
  cursor?: string;
  status?: string;
  from?: string;
  to?: string;
}>;

export type AutomationRequests = Readonly<{
  supportsAutomations(): boolean;
  listAutomations(environmentId?: string): Promise<{ automations: Record<string, unknown>[] }>;
  createAutomation(environmentId?: string, templateId?: string): Promise<AutomationDraftResponse>;
  getAutomationDraft(automationId: string, environmentId?: string): Promise<AutomationDraftResponse>;
  mutateAutomationDraft(automationId: string, expectedRevision: number, mutation: Record<string, unknown>, environmentId?: string): Promise<AutomationDraftResponse>;
  deleteAutomationDraft(automationId: string, expectedRevision: number, environmentId?: string): Promise<{ ok: true }>;
  archiveAutomation(automationId: string, expectedRevision: number, environmentId?: string): Promise<AutomationDraftResponse>;
  restoreAutomation(automationId: string, expectedRevision: number, environmentId?: string): Promise<AutomationDraftResponse>;
  saveAutomationAgent(automationId: string, nodeId: string, expectedRevision: number, environmentId?: string): Promise<Record<string, unknown>>;
  validateAutomation(automationId: string, environmentId?: string): Promise<Record<string, unknown>>;
  publishAutomation(automationId: string, expectedRevision: number, environmentId?: string): Promise<Record<string, unknown>>;
  setAutomationActive(automationId: string, active: boolean, environmentId?: string): Promise<Record<string, unknown>>;
  setAutomationPermission(automationId: string, input: { expectedGrantRevision: number; mode: "full_access" | "full_plus"; operations: OperationRef[] }, environmentId?: string): Promise<Record<string, unknown>>;
  getAutomationCatalog(automationId: string, environmentId?: string): Promise<Record<string, unknown>>;
  startAutomationRun(automationId: string, idempotencyKey: string, environmentId?: string): Promise<Record<string, unknown>>;
  listAutomationRuns(automationId: string, environmentId?: string, query?: AutomationRunHistoryQuery): Promise<Record<string, unknown>>;
  getAutomationRun(runId: string, environmentId?: string): Promise<Record<string, unknown>>;
  getAutomationStepEvidence(runId: string, nodeId: string, environmentId?: string, full?: boolean): Promise<Record<string, unknown>>;
  stopAutomationRun(runId: string, environmentId?: string): Promise<Record<string, unknown>>;
  rerunAutomationRun(runId: string, idempotencyKey: string, environmentId?: string): Promise<Record<string, unknown>>;
}>;

export declare function createAutomationRequests(options: {
  requestApi(path: string, options?: RequestInit): Promise<Record<string, unknown>>;
  getEnvironmentId(): string;
  getConfig(): Record<string, unknown> | null;
}): AutomationRequests;
