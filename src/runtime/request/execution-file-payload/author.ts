import { MODEL_STEPS } from "../../../shared/model-steps.js";
import { resolvePayloadModelTimeout } from "../../orchestration/worker-capabilities/payload-author-failure.js";
import { resolveRequestModelStepInvoker } from "../../model/invoke-step.js";
import { resolveOutputIncompleteError } from "../../model/provider-completion.js";
import type { WorkerCapabilityPayloadAuthor } from "../../orchestration/worker-capabilities/payload-contracts.js";
import type { ExecutionPolicyAuthoritySnapshot } from "../../orchestration/role-calls/index.js";
import { normalizePayloadBody } from "../../orchestration/worker-capabilities/payload-body-normalization.js";
import { isFilePayloadAssignmentValid } from "./binding.js";
import { buildFilePayloadInput, type FilePayloadRequest } from "./context.js";
import { createFilePayloadCompactionController } from "./compaction.js";
import { FilePayloadAuthorDeclinedError, parseFilePayloadOutput } from "./output.js";
import { FilePayloadToolHandoff } from "../../capabilities/file-payload-tool-handoff.js";
import { buildFilePayloadTools, parseFilePayloadToolSelection, type FilePayloadToolCatalog } from "./tools.js";

/** Only a source-bound EA file operation enters this isolated content author. */
export function routeFilePayloadAuthor(
  request: FilePayloadRequest,
  legacy: WorkerCapabilityPayloadAuthor,
  authority?: ExecutionPolicyAuthoritySnapshot,
  toolCatalog?: () => FilePayloadToolCatalog,
): WorkerCapabilityPayloadAuthor {
  return Object.freeze({ async author(input) {
    if (!input.preparedPayload) return legacy.author(input);
    if (!isFilePayloadAssignmentValid(input, request.requestId, authority)) {
      return { status: "failed", code: "payload_context_invalid" };
    }
    let projection;
    let tools;
    try {
      tools = toolCatalog ? await buildFilePayloadTools(toolCatalog(), input) : undefined;
      projection = buildFilePayloadInput(request, input, tools);
    }
    catch { return { status: "failed", code: "payload_context_invalid" }; }
    const modelStep = MODEL_STEPS.EXECUTION_FILE_PAYLOAD_RAW;
    try {
      const body = await resolveRequestModelStepInvoker(request).invoke({
        modelStep, messages: projection.messages,
        contextCompaction: createFilePayloadCompactionController(request, input, projection),
        boundSteeringVersion: input.requestSteering!.version,
        timeoutReason: "execution_file_payload_timeout",
        accept(text, diagnostics) {
          const incomplete = resolveOutputIncompleteError(diagnostics, modelStep);
          if (incomplete) throw incomplete;
          let body;
          try { body = parseFilePayloadOutput(text, projection.outputProtocol); }
          catch (error) {
            if (!(error instanceof FilePayloadToolHandoff) || !tools) throw error;
            parseFilePayloadToolSelection(error.selection, tools.contract);
            return error;
          }
          const bytes = Buffer.byteLength(body, "utf8");
          if (bytes > projection.outputByteLimit) throw new Error("payload_body_too_large");
          if (bytes < input.contract.minBytes) throw new Error("payload_body_too_small");
          if (!normalizePayloadBody(body, input.preparedPayload?.responseFormat).ok) throw new Error("payload_model_output_invalid");
          return body;
        },
      });
      if (body instanceof FilePayloadToolHandoff) throw body;
      return { status: "authored", body };
    } catch (error) {
      if (request.abortSignal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      if (error instanceof FilePayloadAuthorDeclinedError) throw error;
      if (error instanceof FilePayloadToolHandoff && tools) {
        throw error;
      }
      const timeout = resolvePayloadModelTimeout(error, modelStep);
      if (timeout) return timeout;
      return { status: "failed", code: payloadFailureCode(error) };
    }
  } });
}

function payloadFailureCode(error: unknown) {
  if (!(error instanceof Error)) return "payload_model_invocation_failed";
  if (error.message === "payload_body_too_large") return "payload_body_too_large";
  if (error.message === "payload_body_too_small") return "payload_body_too_small";
  if (error.message === "payload_model_output_invalid") return "payload_model_output_invalid";
  if (error.message.startsWith("request_context_") || error.message.startsWith("context_compaction_")) {
    return "payload_context_budget_exceeded";
  }
  return "payload_model_invocation_failed";
}
