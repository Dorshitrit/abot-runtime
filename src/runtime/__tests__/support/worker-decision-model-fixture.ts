import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { MODEL_STEPS } from "../../../shared/model-steps.js";
import type { RequestRunnerConfig } from "../../config/runner/contracts.js";
import type { ModelGatewayClient } from "../../ports.js";

const steps = {
  [MODEL_STEPS.WORKER_EVIDENCE]: "worker.evidence",
  [MODEL_STEPS.WORKER_DECISION]: "worker.decision",
  [MODEL_STEPS.WORKER_RESULT]: "supervisor.response",
  [MODEL_STEPS.CAPABILITY_CONTROLS]: "capability.controls",
};

export function createWorkerDecisionRunnerConfig(): RequestRunnerConfig {
  return {
    models: { defaults: { profileId: "runtime-default", steps } },
    context: { outputReserveTokens: 1_000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
    steps: Object.fromEntries(Object.keys(steps).map((step) => [step, { timeoutMs: 20_000 }])) as RequestRunnerConfig["steps"],
  };
}

export function createWorkerDecisionModelPolicy(contextWindowTokens: number, controlsCalibration = false) {
  return {
    providers: { local: { type: "ollama" as const } },
    profiles: {
      "runtime-default": {
        provider: "local", model: "runtime-default:latest", contextWindowTokens, supportsThinking: true,
        calibration: { "worker.evidence": {}, "worker.decision": {}, ...(controlsCalibration ? { "capability.controls": {} } : {}) },
      },
    },
    defaults: { profileId: "runtime-default", steps },
  };
}

/** Evidence is an explicit model call; legacy scenario callbacks still own selection and controls. */
export function createWorkerEvidenceModel(invoke: ModelGatewayClient["invoke"]) {
  let decisions: readonly boolean[] | undefined;
  let assessmentIndex = 0;
  const model = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep !== MODEL_STEPS.WORKER_EVIDENCE) return invoke(input);
    const requiresExecution = nextEvidenceDecision();
    const assignment = readEvidenceAssignment(input.messages as readonly ChatMessage[]);
    return {
      text: JSON.stringify({ decision: {
        requiresExecution,
        established: assignment.evidenceRefs.length ? "The supplied execution evidence establishes the fixture's observed state." : "No external execution is established yet.",
        remaining: requiresExecution ? "The fixture's assigned operation remains to be executed." : "",
        evidenceRefs: assignment.evidenceRefs,
      } }),
      meta: {},
    };
  });
  function nextEvidenceDecision(): boolean {
    if (!decisions) return true;
    const decision = decisions[assessmentIndex++];
    if (decision === undefined) throw new Error("unexpected_fixture_evidence_assessment");
    return decision;
  }
  return Object.assign(model, {
    withEvidenceDecisions(...sequence: readonly boolean[]) {
      decisions = sequence;
      return model;
    },
  });
}

function readEvidenceAssignment(messages: readonly ChatMessage[]): { evidenceRefs: readonly string[] } {
  for (const message of messages) {
    let value: unknown;
    try { value = JSON.parse(message.content); } catch { continue; }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.kind !== "runtime_worker_evidence_assignment_v1") continue;
    if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.some((ref) => typeof ref !== "string"))
      throw new Error("fixture_evidence_references_invalid");
    return { evidenceRefs: record.evidenceRefs };
  }
  throw new Error("fixture_evidence_assignment_missing");
}
