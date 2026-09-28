import type {
  PendingWebToolApproval,
  WebToolApprovalDecision,
} from "../../../local-runtime/pending-tool-approvals.js";

export interface ToolApprovalRequests {
  supportsToolApprovals(): boolean;
  listToolApprovals(
    environmentId?: string,
  ): Promise<{ approvals: PendingWebToolApproval[] }>;
  decideToolApproval(
    decision: WebToolApprovalDecision,
  ): Promise<{ ok: true; approvalId: string }>;
}

export declare function createToolApprovalRequests(options: {
  requestApi(path: string, options?: RequestInit): Promise<unknown>;
  getEnvironmentId(): string;
  getConfig(): Record<string, unknown> | null;
}): ToolApprovalRequests;
