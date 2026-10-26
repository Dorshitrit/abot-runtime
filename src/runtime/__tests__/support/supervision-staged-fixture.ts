import { workerEvidenceReply } from "./worker-evidence-script.js";
import { semanticCompactionDigestSlots } from "./semantic-compaction-model-fixture.js";
import { vi } from "vitest";
import { withSupervisorPreparation } from "./supervisor-model-phases.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient } from "../../ports.js";
import type { RequestRunnerConfig } from "../../config/runner/contracts.js";
import { runRequestRunner } from "../../request/runner.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";
import {
  compactContinuation,
  readCompactionEnvelope,
} from "./semantic-compaction-contract-fixture.js";

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

export function supervisionStagedFixture(
  policy: "execution-agent-v1" | "supervisor-worker-v1",
  options: {
    oversized?: boolean;
    estimated?: boolean;
    abortDuringCompaction?: boolean;
    registeredResult?: "aliased-summary" | "independent-summary";
  } = {},
) {
  const throughPlanner = true;
  const abort = new AbortController();
  const prompt =
    "Inspect report.txt, compare observations, and review the evidence.";
  const profileId = "staged-super";
  const pressuredInputTokens = policy === "execution-agent-v1" ? 29_000 : 24_000;
  const compactionSteps = policy === "supervisor-worker-v1"
    ? [
        "super.compact.coverage",
        "super.compact.content",
        "super.compact.merge",
        "super.compact.continuation",
      ]
    : ["context.compact"];
  const calls: Array<{ step: string; messages: readonly ChatMessage[] }> = [];
  const events: Array<{ name: string; data?: Record<string, unknown> }> = [];
  let supervisorTurns = 0;
  let plannerTurns = 0;
  let workerTurns = 0;
  let controlsTurns = 0;
  let compactionTurns = 0;
  let executionTurns = 0;
  const counted: Array<{ step: string; messages: readonly ChatMessage[] }> = [];
  const decision = (value: unknown) => ({
    text: JSON.stringify({ decision: value }),
    meta: {},
  });
  const descriptor = {
    capabilityId: "inspect_record",
    summary: "Inspect one canonical record.",
    effect: "observation" as const,
    catalogGroups: ["other"],
    selectionControlIds: [],
    controls: {
      type: "object" as const,
      additionalProperties: false as const,
      properties: {
        query: { type: "string" as const, minLength: 1, maxLength: 128 },
      },
      required: ["query"],
    },
  };
  const registeredOutput = `${STAGED_RAW_MARKER}:${"registered source detail ".repeat(240)}${STAGED_FACT}`;
  const execute = vi.fn(
    async (_input: { controls: Readonly<Record<string, unknown>> }) => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary:
        options.registeredResult === "aliased-summary"
          ? registeredOutput
          : STAGED_FACT,
      referenceData: options.estimated
        ? "Estimator source reference."
        : `${STAGED_RAW_MARKER}:${"source detail ".repeat(700)}${STAGED_FACT}`,
      references: [{ kind: "tool_target" as const, target: "report.txt" }],
      exactResult: options.registeredResult
        ? {
            kind: "registered_tool_execution_result_v1" as const,
            authority: "registered_plugin" as const,
            status: "executed" as const,
            result: {
              ok: true,
              tool: "inspect_record",
              output: registeredOutput,
              producedNewInformation: true,
            },
          }
        : {
            kind: "generic_capability_result_v1" as const,
            authority: "capability_adapter" as const,
            status: "executed" as const,
            ok: true,
            payload: {
              fact: STAGED_FACT,
              ...(options.estimated
                ? { detail: "exact evidence ".repeat(1300) }
                : {}),
            },
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
            items: [{ title: "Inspect target", objective: prompt }],
          },
          selectedItemIndexes: [0],
          workerCapabilityScope: { catalogGroupIds: ["other"] },
        });
      return decision({ action: "return_result", result: STAGED_FACT });
    }
    if (step === "worker.evidence") return workerEvidenceReply(input, workerTurns < 3, STAGED_FACT);
    if (step === "worker.decision") {
      workerTurns += 1;
      return decision({
          action: "invoke_capability",
          capabilityId: descriptor.capabilityId,
          intent: "Inspect the canonical target.",
        });
    }
    if (step === "execution.decision") {
      executionTurns += 1;
      if (executionTurns === 1)
        return decision({
          action: "open_capability_scope",
          catalogGroupIds: ["other"],
          acknowledgement: "Inspecting evidence.",
        });
      if (executionTurns <= 4)
        return decision({
          action: "invoke_capability",
          capabilityId: descriptor.capabilityId,
          intent: "Inspect target.",
          selectionControls: { query: "same-observation" },
          ...(executionTurns === 2 ? { workingDirectory: "." } : {}),
        });
      return decision({ action: "respond" });
    }
    if (step === "execution.response") return { text: STAGED_FACT, meta: {} };
    if (step === "capability.controls") {
      controlsTurns += 1;
      return decision({
        action: "invoke_capability",
        controls: {
          query: "same-observation",
        },
      });
    }
    if (policy === "supervisor-worker-v1" && compactionSteps.includes(step)) {
      if (options.abortDuringCompaction)
        abort.abort(new Error("cancel_supervision_compaction"));
      return { text: STAGED_FACT, meta: {} };
    }
    if (step === "context.compact") {
      if (options.abortDuringCompaction)
        abort.abort(new Error("cancel_supervision_compaction"));
      compactionTurns += 1;
      const envelope = readCompactionEnvelope(messages);
      const repairRequired = false;
      return {
        text: JSON.stringify({
          continuation: repairRequired
            ? compactContinuation({
                currentState: "x".repeat(2000),
                nextStep: "n".repeat(2000),
                findings: ["a".repeat(2000), "b".repeat(2000), "x"],
              })
            : compactContinuation({
                currentState: STAGED_FACT,
                findings: [STAGED_FACT],
                evidenceRefs: envelope.newSources!.map(
                  ({ sourceRef }) => sourceRef,
                ),
              }),
          sourceDigests: semanticCompactionDigestSlots(
            envelope.newSources!.map(() => STAGED_FACT),
          ),
        }),
        meta: {},
      };
    }
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
  >(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    counted.push({ step: input.modelStep!, messages });
    const notice = decodeCapsules(messages).find(
      ({ kind }) => kind === "runtime_operation_supervision_evidence_v1",
    );
    const hasNativeResults = messages.some(({ role }) => role === "tool");
    const hasWorkerResults = decodeCapsules(messages).some(
      (capsule) =>
        capsule.kind === "runtime_request_tool_results_v1" &&
        (capsule.results as Array<{ adapterResult?: unknown }>).some(
          ({ adapterResult }) => adapterResult !== undefined,
        ),
    );
    const hasRegisteredBody =
      options.registeredResult !== undefined &&
      JSON.stringify(messages).includes(registeredOutput);
    return {
      inputTokens:
        notice &&
        (options.oversized ||
          hasNativeResults ||
          hasWorkerResults ||
          hasRegisteredBody)
          ? pressuredInputTokens
          : 1000,
      profileId,
      provider: "openai",
      model: "staged-test",
      contextWindowTokens: 32000,
      source: "provider_input_token_count",
    };
  });
  const request = createTestRequestExecutionScope({
    requestId: `supervision-staged-${policy}`,
    executionPolicySelection: {
      policy,
      primaryProfileId: profileId,
      source: "model_profile",
    },
    sessionId: "staged-session",
    prompt,
    historyMessages: [
      {
        id: "history-1",
        createdAt: "2026-10-02T17:00:00.000Z",
        role: "user",
        content: "Earlier research: inspect sources first.",
      },
      {
        id: "history-2",
        createdAt: "2026-10-02T17:01:00.000Z",
        role: "assistant",
        content: "Research completed: original sources remain available.",
      },
    ],
    temporalContext: {
      currentDateTime: "2026-10-02 21:00:00 GMT+03:00",
      timeZone: "Asia/Jerusalem",
    },
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
          "execution.decision",
          "execution.response",
          "supervisor.decision",
          "supervisor.response",
          "planner.decision",
          "worker.evidence",
          "worker.decision",
          "worker.result",
          "capability.controls",
          "reviewer.decision",
          ...compactionSteps,
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
    modelGatewayClient: {
      invoke,
      invokeRaw: vi.fn(),
      ...(options.estimated ? {} : { countInputTokens }),
    },
    workerCapabilityProvider: {
      getDescriptors: () => [descriptor],
      getAdapters: () => [{ descriptor, execute }],
    },
    toolPermissionMode: "full_access",
    abortSignal: abort.signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: (name, data) => events.push({ name, data }),
  });
  return {
    request,
    calls,
    events,
    counted,
    invoke,
    execute,
    registeredOutput,
    run: () => runRequestRunner(request),
  };
}
