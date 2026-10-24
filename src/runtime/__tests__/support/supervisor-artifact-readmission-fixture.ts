import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { assessRequestMessagesBudget } from "../../context/request-context-budget.js";
import { SESSION_ARTIFACT_PATHS_MESSAGE_KIND } from "../../context/session-artifact-paths.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import type { ModelGatewayClient } from "../../ports.js";
import { buildSupervisorCapabilityBriefOptions } from "../../steps/supervisor-decision/capability-brief.js";
import { buildSupervisorDelegationInput } from "../../steps/supervisor-decision/delegation-input.js";
import { runSupervisorDecision } from "../../steps/supervisor-decision/run.js";
import { deriveTestRequestExecutionScope, type TestRequestSeed } from "./request-execution-scope.js";
import { createReadmissionFixture } from "./supervisor-brief-readmission-fixture.js";

export type ArtifactModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
export const ARTIFACT_TARGET = ".exact-artifacts/news.txt";

export function modelMessages(
  input: ArtifactModelInput,
): readonly ChatMessage[] {
  return input.messages as readonly ChatMessage[];
}

export function modelFormatName(input: ArtifactModelInput): string | undefined {
  if (typeof input.format !== "object") return undefined;
  return typeof input.format?.name === "string" ? input.format.name : undefined;
}

export function isArtifactMessage(message: ChatMessage): boolean {
  if (message.role !== "system") return false;
  try {
    return (
      JSON.parse(message.content).kind === SESSION_ARTIFACT_PATHS_MESSAGE_KIND
    );
  } catch {
    return false;
  }
}

export function createArtifactReadmissionFixture(
  options: {
    contextWindowTokens?: number;
    historyMessages?: TestRequestSeed["historyMessages"];
    targets?: readonly string[];
    repairPhase?: "routing" | "directory";
    steeringText?: string;
    calibration?: string;
    methodology?: string;
    objective?: string;
    countInputTokens?: ModelGatewayClient["countInputTokens"];
  } = {},
) {
  const fixture = createReadmissionFixture({
    contextWindowTokens: options.contextWindowTokens ?? 40_000,
    calibration: options.calibration,
    methodology: options.methodology,
  });
  const events: { name: string; extra?: Record<string, unknown> }[] = [];
  let routingCalls = 0;
  let directoryCalls = 0;
  const objective = options.objective ?? "Update the saved news summary.";
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (modelFormatName(input) === "supervisor_procedure_gate")
      return { text: JSON.stringify({ decision: { requiresProcedure: true } }), meta: {} };
    if (modelFormatName(input) === "supervisor_working_directory") {
      directoryCalls += 1;
      return {
        text:
          options.repairPhase === "directory" && directoryCalls === 1
            ? "{"
            : JSON.stringify({ workingDirectory: ".exact-artifacts" }),
        meta: {},
      };
    }
    routingCalls += 1;
    if (routingCalls === 1 && options.steeringText) {
      fixture.steering.append({
        steerId: "new-steering",
        text: options.steeringText,
      });
    }
    return {
      text:
        options.repairPhase === "routing" && routingCalls === 1
          ? "{"
          : JSON.stringify({
              decision: {
                action: "invoke_role",
                roleId: "worker",
                objective,
              },
            }),
      meta: {},
    };
  });
  const request = deriveTestRequestExecutionScope(fixture.request, {
    sessionArtifactPaths: options.targets ?? [ARTIFACT_TARGET],
    historyMessages: options.historyMessages ?? fixture.request.historyMessages,
    modelGatewayClient: {
      invoke,
      invokeRaw: vi.fn(),
      ...(options.countInputTokens
        ? { countInputTokens: options.countInputTokens }
        : {}),
    },
    onEvent: (name, extra) => {
      events.push({ name, extra });
    },
  });
  const runOptions = {
    call: {
      rootCallId: "call-1",
      callId: "call-1",
      parentCallId: null,
      depth: 0,
      invocationAttempt: 1,
    },
    toolResults: { sourceRevision: 1, results: [] },
    allowedRoleIds: fixture.input.allowedRoleIds,
    availableWorkerCapabilityCatalog:
      fixture.input.availableWorkerCapabilityCatalog,
  };
  const input = buildSupervisorDelegationInput(request, {
    ...runOptions,
    ...buildSupervisorCapabilityBriefOptions(request, runOptions),
  });
  const assess = (messages: readonly ChatMessage[], format = input.format) => {
    const { budget, invocation } = resolveModelContextAdmission({
      runnerConfig: request.runnerConfig,
      agentMode: request.agentMode,
      modelStep: "supervisor.decision",
      modelPolicy: request.modelPolicy,
      requestFormat: format,
    });
    const instructions = invocation.instructions ?? [];
    const assessedMessages =
      instructions.length > 0
        ? [
            { role: "system" as const, content: instructions.join("\n") },
            ...messages,
          ]
        : messages;
    return assessRequestMessagesBudget({
      messages: assessedMessages,
      format,
      budget,
    }).budget;
  };
  return {
    ...fixture,
    request,
    input,
    invoke,
    events,
    assess,
    run: () => runSupervisorDecision(request, runOptions),
    inputs: () => invoke.mock.calls.map(([input]) => input),
    // Existing artifact oracles target the two work phases; the gate has no references.
    workInputs: () => invoke.mock.calls.map(([input]) => input)
      .filter((input) => modelFormatName(input) !== "supervisor_procedure_gate"),
  };
}
