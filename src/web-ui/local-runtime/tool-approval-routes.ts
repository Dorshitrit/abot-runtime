import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonObject } from "./contracts.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { getString, sendJson } from "./http.js";
import type {
  PendingWebToolApproval,
  WebToolApprovalDecision,
} from "./pending-tool-approvals.js";

export type WebToolApprovalAccess = {
  list(environmentId: string): Promise<PendingWebToolApproval[]>;
  decide(decision: WebToolApprovalDecision): Promise<boolean>;
};

type ApprovalRouteRequest = {
  method: string;
  segments: string[];
  body: JsonObject | null;
  environmentId: string;
  request: IncomingMessage;
  response: ServerResponse;
};

function hasApprovalDecisionScope(body: JsonObject | null): boolean {
  if (!getString(body?.environment).trim()) return false;
  if (!getString(body?.sessionId).trim()) return false;
  if (!getString(body?.requestId).trim()) return false;
  return typeof body?.approved === "boolean";
}

export class ToolApprovalRoutes {
  constructor(private readonly approvals: WebToolApprovalAccess) {}

  async handle(input: ApprovalRouteRequest): Promise<boolean> {
    const { method, segments, body, environmentId, request, response } = input;
    if (segments[0] !== "chat" || segments[1] !== "approvals") return false;
    response.setHeader("cache-control", "no-store");
    if (method === "GET" && segments.length === 2) {
      sendJson(response, 200, {
        ok: true,
        approvals: await this.approvals.list(environmentId),
      });
      return true;
    }
    if (method !== "POST" || segments.length !== 3) return false;
    if (!acceptConfigMutationRequest(request, response)) return true;
    if (!hasApprovalDecisionScope(body)) {
      sendJson(response, 400, {
        ok: false,
        error: "invalid_tool_approval_decision",
        message:
          "The approval decision is missing its conversation or request.",
      });
      return true;
    }
    const accepted = await this.approvals.decide({
      approvalId: segments[2],
      environmentId,
      sessionId: getString(body?.sessionId),
      requestId: getString(body?.requestId),
      approved: body?.approved === true,
      ...(typeof body?.generation === "string"
        ? { generation: body.generation }
        : {}),
      ...(typeof body?.waitId === "string" ? { waitId: body.waitId } : {}),
      ...(typeof body?.revision === "number"
        ? { revision: body.revision }
        : {}),
      ...(typeof body?.commandId === "string"
        ? { commandId: body.commandId }
        : {}),
      ...(typeof body?.reason === "string" ? { reason: body.reason } : {}),
    });
    if (!accepted) {
      sendJson(response, 409, {
        ok: false,
        error: "tool_approval_not_pending",
        message:
          "This action is no longer waiting for your decision. Refresh to see current approvals.",
      });
      return true;
    }
    sendJson(response, 200, { ok: true, approvalId: segments[2] });
    return true;
  }
}
