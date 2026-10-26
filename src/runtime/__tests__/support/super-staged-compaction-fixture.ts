import { workerEvidenceReply } from "./worker-evidence-script.js";
import { vi } from "vitest";
import { withSupervisorPreparation } from "./supervisor-model-phases.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient } from "../../ports.js";
import type { RequestRunnerConfig } from "../../config/runner/contracts.js";
import { runRequestRunner } from "../../request/runner.js";
import {
  createTestRequestExecutionScope,
  deriveTestRequestExecutionScope,
} from "./request-execution-scope.js";
import { projectSuperCompactionConfiguration } from "../../context/super-compaction/configuration.js";

export const STAGED_FACT =
  "report.txt: expected=ready; observed=failed; verification=reviewed";
export const STAGED_RAW_MARKER = "UNCOMPACTED_CANONICAL_SOURCE";

function decodeCapsules(
  messages: readonly ChatMessage[],
): Record<string, unknown>[] {
  return messages.flatMap(({ content }) => {
    try {
      const parsed = JSON.parse(content);
      return typeof parsed === "object" && parsed !== null ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

export function stagedSuperFixture(
  throughPlanner: boolean,
  options: { twoWorkers?: boolean } = {},
) {
  const prompt =
    "Inspect report.txt, compare observations, and review the evidence.";
  const profileId = "staged-super";
  const calls: Array<{ step: string; messages: readonly ChatMessage[] }> = [];
  const events: Array<{ name: string; data?: Record<string, unknown> }> = [];
  let supervisorTurns = 0;
  let plannerTurns = 0;
  let workerTurns = 0;
  let controlsTurns = 0;
  const decision = (value: unknown) => ({
    text: JSON.stringify({ decision: value }),
    meta: {},
  });
  const descriptor = {
    capabilityId: "inspect_record",
    summary: "Inspect one canonical record.",
    effect: "observation" as const,
    catalogGroups: ["other"],
    controls: {
      type: "object" as const,
      additionalProperties: false as const,
      properties: {
        query: { type: "string" as const, minLength: 1, maxLength: 128 },
      },
      required: ["query"],
    },
  };
  const execute = vi.fn(
    async (_input: { controls: Readonly<Record<string, unknown>> }) => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: STAGED_FACT,
      referenceData: `${STAGED_RAW_MARKER}:${"source detail ".repeat(700)}${STAGED_FACT}`,
      references: [{ kind: "tool_target" as const, target: "report.txt" }],
      exactResult: {
        kind: "generic_capability_result_v1" as const,
        authority: "capability_adapter" as const,
        status: "executed" as const,
        ok: true,
        payload: { fact: STAGED_FACT },
      },
    }),
  );
  const respond = withSupervisorPreparation(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    const step = input.modelStep!;
    const formatName = (input.format as { name?: string } | undefined)?.name;
    if (formatName === "supervisor_working_directory")
      return { text: '{"workingDirectory":"."}', meta: {} };
    if (step === "supervisor.decision") {
      supervisorTurns += 1;
      if (supervisorTurns === 1)
        return decision({
          action: "invoke_role",
          roleId: throughPlanner ? "planner" : "worker",
          objective: prompt,
          ...(!throughPlanner
            ? { workerCapabilityScope: { catalogGroupIds: ["other"] } }
            : {}),
          acknowledgement: "Inspecting the requested evidence.",
        });
      if (supervisorTurns === 2)
        return decision({ action: "invoke_role", roleId: "reviewer" });
      return decision({ action: "respond" });
    }
    if (step === "planner.decision") {
      plannerTurns += 1;
      if (plannerTurns === 1)
        return decision({
          action: "invoke_role",
          roleId: "worker",
          plan: {
            summary: prompt,
            items: [
              { title: "Inspect target", objective: prompt },
              ...(options.twoWorkers
                ? [{ title: "Compare target", objective: prompt }]
                : []),
            ],
          },
          selectedItemIndexes: [0],
          workerCapabilityScope: { catalogGroupIds: ["other"] },
        });
      if (options.twoWorkers && plannerTurns === 2)
        return decision({
          action: "invoke_role",
          roleId: "worker",
          planItemIds: ["plan-call-2-item-2"],
          workerCapabilityScope: { catalogGroupIds: ["other"] },
        });
      return decision({ action: "return_result", result: STAGED_FACT });
    }
    if (step === "worker.evidence") {
      if (workerTurns !== 3) return workerEvidenceReply(input, true);
      workerTurns = 0;
      return workerEvidenceReply(input, false, STAGED_FACT);
    }
    if (step === "worker.decision") {
      workerTurns += 1;
      return decision({
        action: "invoke_capability",
        capabilityId: descriptor.capabilityId,
        intent: "Inspect the canonical target.",
      });
    }
    if (step === "capability.controls") {
      controlsTurns += 1;
      if (controlsTurns % 3 === 1)
        return decision({
          action: "return_failure",
          reason: "The first selection needs reconsideration before execution.",
        });
      return decision({
        action: "invoke_capability",
        controls: {
          query:
            controlsTurns % 3 === 2
              ? "first-observation"
              : "second-observation",
        },
      });
    }
    if (step.startsWith("super.compact."))
      return { text: STAGED_FACT, meta: {} };
    if (step === "worker.result") return { text: STAGED_FACT, meta: {} };
    if (step === "reviewer.decision") {
      const audit = decodeCapsules(messages).find(
        ({ kind }) => kind === "runtime_reviewer_audit_v4",
      )! as {
        auditScope: { reviewScopeId: string };
        effects: readonly { evidenceRef: string }[];
      };
      return decision({
        action: "pass",
        reviewScopeId: audit.auditScope.reviewScopeId,
        audit: {
          evidenceAssessments: audit.effects.map(({ evidenceRef }) => ({
            evidenceRef,
            status: "supports",
            finding: STAGED_FACT,
          })),
          completionAssessment: {
            status: "satisfied",
            evidenceRefs: audit.effects.map(({ evidenceRef }) => evidenceRef),
            finding: STAGED_FACT,
          },
        },
        summary: STAGED_FACT,
        gaps: [],
      });
    }
    if (step === "supervisor.response") return { text: STAGED_FACT, meta: {} };
    throw new Error(`unexpected_staged_model_step:${step}`);
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    calls.push({
      step: input.modelStep!,
      messages: input.messages as readonly ChatMessage[],
    });
    return respond(input);
  });
  const countInputTokens = vi.fn<
    NonNullable<ModelGatewayClient["countInputTokens"]>
  >(async (input) => ({
    inputTokens:
      input.modelStep === "worker.evidence" &&
      decodeCapsules(input.messages as readonly ChatMessage[]).some(
        (capsule) =>
          capsule.kind === "runtime_request_tool_results_v1" &&
          JSON.stringify(capsule.results).includes(STAGED_RAW_MARKER),
      )
        ? 24000
        : 1000,
    profileId,
    provider: "openai",
    model: "staged-test",
    contextWindowTokens: 32000,
    source: "provider_input_token_count",
  }));
  const original = createTestRequestExecutionScope({
    requestId: `staged-super-${throughPlanner}`,
    sessionId: "staged-session",
    prompt,
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    agentMode: "reasoning",
    runnerConfig: {
      models: { defaults: { profileId, steps: {} } },
      context: {
        outputReserveTokens: 2048,
        safetyReserveTokens: 512,
        attachmentReserveTokens: 0,
      },
      steps: Object.fromEntries(
        [
          "supervisor.decision",
          "supervisor.response",
          "planner.decision",
          "worker.evidence",
          "worker.decision",
          "worker.result",
          "capability.controls",
          "reviewer.decision",
          "context.compact",
        ].map((step) => [step, { timeoutMs: 20000 }]),
      ),
    } as RequestRunnerConfig,
    modelPolicy: {
      providers: { test: { type: "openai" } },
      profiles: {
        [profileId]: {
          provider: "test",
          model: "staged-test",
          contextWindowTokens: 32000,
        },
      },
      defaults: { profileId, steps: {} },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn(), countInputTokens },
    workerCapabilityProvider: {
      getDescriptors: () => [descriptor],
      getAdapters: () => [{ descriptor, execute }],
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: (name, data) => events.push({ name, data }),
  });
  const request = deriveTestRequestExecutionScope(
    original,
    projectSuperCompactionConfiguration(
      original,
      original.executionPolicy.authority,
    ),
  );
  return {
    request,
    calls,
    events,
    invoke,
    execute,
    run: () => runRequestRunner(request),
  };
}
