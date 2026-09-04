import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ToolAvailabilityEntry } from "../../../capabilities/tool-types.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import { resolveRequestCapabilityBriefEntries } from "../../request/capability-brief.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { appendRequestSteeringContext } from "../../request/request-steering-context.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import type { WorkerCapabilityCatalogGroup } from "../../orchestration/worker-capabilities/index.js";
import {
  SUPERVISOR_DECISION_MODEL_STEP,
  SUPERVISOR_DELEGATE_ROLE_IDS,
} from "./contracts.js";

type BriefOptions = Readonly<{
  allowedRoleIds?: readonly string[];
  availableWorkerCapabilityCatalog?: readonly WorkerCapabilityCatalogGroup[];
}>;

/** Only routing opts in; neither the Worker nor later authoring is changed. */
export function buildSupervisorCapabilityBriefOptions(
  request: RequestExecutionScope,
  options: BriefOptions,
): Readonly<{
  capabilityBriefEntries?: readonly ToolAvailabilityEntry[];
  capabilityBriefBudgetMessages?: readonly ChatMessage[];
}> {
  if (!canProjectSupervisorCapabilityBrief(options)) return {};
  const entries = resolveRequestCapabilityBriefEntries(
    request.capabilities,
    options.availableWorkerCapabilityCatalog ?? [],
  );
  const admission = resolveModelContextAdmission({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const instructions = (admission.invocation.instructions ?? [])
    .map((instruction) => instruction.trim())
    .filter((instruction) => instruction.length > 0);
  const calibration: ChatMessage[] = [];
  if (instructions.length > 0) {
    calibration.push({ role: "system", content: instructions.join("\n") });
  }
  const capabilityBriefBudgetMessages = appendRequestSteeringContext(
    calibration,
    resolveRequestSteeringInbox(request.requestSteering).snapshot(),
  );
  return Object.freeze({
    ...(entries === undefined ? {} : { capabilityBriefEntries: entries }),
    capabilityBriefBudgetMessages,
  });
}

function canProjectSupervisorCapabilityBrief(options: BriefOptions): boolean {
  const roles = options.allowedRoleIds ?? SUPERVISOR_DELEGATE_ROLE_IDS;
  if (!roles.includes("worker")) return false;
  return (options.availableWorkerCapabilityCatalog?.length ?? 0) > 0;
}
