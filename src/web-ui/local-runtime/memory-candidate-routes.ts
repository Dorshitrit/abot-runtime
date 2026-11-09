import type { IncomingMessage, ServerResponse } from "node:http";
import type { LongTermMemoryManagementService, MemoryCandidateActionInput } from "../../runtime/long-term-memory/management/contracts.js";
import { LongTermMemoryManagementError } from "../../runtime/long-term-memory/management/errors.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";
import { projectWebMemoryRecord } from "./memory-management-response.js";
import { withHttpRequestAbortSignal } from "./request-abort.js";

type CandidateRouteRequest = Readonly<{
  method: string; segments: readonly string[]; body: Record<string, unknown> | null;
  request: IncomingMessage; response: ServerResponse;
}>;

export function isMemoryCandidateRoute(segments: readonly string[]): boolean {
  if (segments[0] !== "runtime" || segments[1] !== "memory" || segments[2] !== "candidates") return false;
  if (!segments[3]) return false;
  if (segments.length === 4) return true;
  return segments.length === 5 && segments[4] === "promote";
}

export async function handleMemoryCandidateRoute(request: CandidateRouteRequest, service: LongTermMemoryManagementService): Promise<void> {
  request.response.setHeader("cache-control", "no-store");
  const promote = request.segments[4] === "promote";
  const allowedMethod = promote ? "POST" : "DELETE";
  if (request.method !== allowedMethod) {
    request.response.setHeader("allow", allowedMethod);
    sendJson(request.response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  if (!acceptConfigMutationRequest(request.request, request.response)) return;
  const target = readCandidateActionInput(request.segments[3], request.body);
  if (promote) {
    if (!service.promoteCandidate) throw new LongTermMemoryManagementError("long_term_memory_unavailable");
    const result = await withHttpRequestAbortSignal({ request: request.request, response: request.response,
      reason: "memory_candidate_request_aborted", run: abortSignal => service.promoteCandidate!({ ...target,
        source: "web_ui", context: { abortSignal } }) });
    sendJson(request.response, 200, { ok: true, record: projectWebMemoryRecord(result.record) });
    return;
  }
  if (!service.deleteCandidate) throw new LongTermMemoryManagementError("long_term_memory_unavailable");
  const result = await service.deleteCandidate(target);
  sendJson(request.response, 200, { ok: true, deleted: result.deleted });
}

function readCandidateActionInput(id: string, body: Record<string, unknown> | null): MemoryCandidateActionInput {
  const allowed = ["revision", "environment", "environmentId"];
  if (!body || Object.keys(body).some(field => !allowed.includes(field))) throw invalidCandidateAction();
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1) throw invalidCandidateAction();
  return { id, revision: Number(body.revision) };
}

function invalidCandidateAction(): LongTermMemoryManagementError {
  return new LongTermMemoryManagementError("long_term_memory_management_input_invalid");
}
