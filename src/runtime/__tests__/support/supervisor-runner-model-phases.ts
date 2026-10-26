import { MODEL_STEPS } from "../../../shared/model-steps.js";
import type { RequestRunnerConfig } from "../../config/runner/contracts.js";
import { CAPABILITY_CONTROLS_MODEL_STEP, WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP } from "../../orchestration/worker-capabilities/index.js";
import { PLANNER_DECISION_MODEL_STEP } from "../../steps/planner-decision/index.js";
import { REVIEWER_DECISION_MODEL_STEP } from "../../steps/reviewer-decision/index.js";
import { SUPERVISOR_DECISION_MODEL_STEP } from "../../steps/supervisor-decision/index.js";
import { SUPERVISOR_RESPONSE_MODEL_STEP } from "../../steps/supervisor-response/index.js";
import { WORKER_DECISION_MODEL_STEP, WORKER_RESULT_MODEL_STEP } from "../../steps/worker-decision/index.js";
import type { ModelGatewayClient } from "../../ports.js";
import { supervisorFormatName, withSupervisorPreparation } from "./supervisor-model-phases.js";

/** Handles only Supervisor preparation; Worker stages remain explicit in each scenario. */
export function separateSupervisorRunnerModelPhases(
  invoke: ModelGatewayClient["invoke"],
  workingDirectories: Readonly<{ planner: string; worker: string }>,
): ModelGatewayClient["invoke"] {
  return withSupervisorPreparation(async (input) => {
    if (supervisorFormatName(input) === "supervisor_working_directory") {
      const frozenInvocation = (
        input.messages as readonly Readonly<{ content: string }>[]
      ).flatMap((message) => {
        try {
          const parsed = JSON.parse(message.content) as Record<string, unknown>;
          return parsed.kind === "runtime_supervisor_frozen_invocation_v1" ? [parsed] : [];
        } catch { return []; }
      }).at(-1);
      if (frozenInvocation?.roleId !== "planner" && frozenInvocation?.roleId !== "worker")
        throw new Error("supervisor_working_directory_fixture_invalid");
      return {
        text: JSON.stringify({ workingDirectory: workingDirectories[frozenInvocation.roleId] }),
        meta: {},
      };
    }
    return invoke(input);
  });
}

export const runnerConfig: RequestRunnerConfig = {
  models: {
    defaults: {
      profileId: "runtime-default",
      steps: {
        [SUPERVISOR_DECISION_MODEL_STEP]: "supervisor.decision",
        [SUPERVISOR_RESPONSE_MODEL_STEP]: "supervisor.response",
        [PLANNER_DECISION_MODEL_STEP]: "planner.decision",
        [REVIEWER_DECISION_MODEL_STEP]: "reviewer.decision",
        [MODEL_STEPS.WORKER_EVIDENCE]: "worker.evidence",
        [WORKER_DECISION_MODEL_STEP]: "worker.decision",
        [WORKER_RESULT_MODEL_STEP]: "supervisor.response",
        [CAPABILITY_CONTROLS_MODEL_STEP]: "capability.controls",
        [WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP]: "toolPayload.raw",
      },
    },
  },
  context: {
    outputReserveTokens: 1_000,
    safetyReserveTokens: 200,
    attachmentReserveTokens: 100,
  },
  steps: {
    [SUPERVISOR_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
    [SUPERVISOR_RESPONSE_MODEL_STEP]: { timeoutMs: 20_000 },
    [PLANNER_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
    [REVIEWER_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
    [MODEL_STEPS.WORKER_EVIDENCE]: { timeoutMs: 20_000 },
    [WORKER_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
    [WORKER_RESULT_MODEL_STEP]: { timeoutMs: 20_000 },
    [CAPABILITY_CONTROLS_MODEL_STEP]: { timeoutMs: 20_000 },
    [WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP]: { timeoutMs: 20_000 },
  } as RequestRunnerConfig["steps"],
};

export const modelPolicy = {
  providers: { local: { type: "ollama" as const } },
  profiles: {
    "runtime-default": {
      provider: "local",
      model: "runtime-default:latest",
      contextWindowTokens: 32_000,
      supportsThinking: true,
      calibration: {
        "supervisor.decision": {},
        "supervisor.response": {},
        "planner.decision": {},
        "reviewer.decision": {},
        "worker.evidence": {},
        "worker.decision": {},
        "capability.controls": {},
        "tool_payload.raw": {},
      },
    },
  },
  defaults: {
    profileId: "runtime-default",
    steps: {
      [SUPERVISOR_DECISION_MODEL_STEP]: "supervisor.decision",
      [SUPERVISOR_RESPONSE_MODEL_STEP]: "supervisor.response",
      [PLANNER_DECISION_MODEL_STEP]: "planner.decision",
      [REVIEWER_DECISION_MODEL_STEP]: "reviewer.decision",
      [MODEL_STEPS.WORKER_EVIDENCE]: "worker.evidence",
      [WORKER_DECISION_MODEL_STEP]: "worker.decision",
      [WORKER_RESULT_MODEL_STEP]: "supervisor.response",
      [CAPABILITY_CONTROLS_MODEL_STEP]: "capability.controls",
      [WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP]: "toolPayload.raw",
    },
  },
};
