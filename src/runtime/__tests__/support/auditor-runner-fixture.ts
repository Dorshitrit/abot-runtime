import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityDescriptor,
} from "../../orchestration/worker-capabilities/index.js";
import type { ModelGatewayClient } from "../../ports.js";
import type { RequestCapabilityExecutionView } from "../../request/execution-scope.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";

export type AuditRunnerInput = Parameters<ModelGatewayClient["invoke"]>[0];
export const AUDIT_RUNNER_PROMPT =
  "Inspect the supplied observations and audit completion.";
export const AUDIT_RUNNER_FINAL =
  "The requested observations have been audited.";
export const AUDIT_CRITERION_IDS = ["request_completion"];

const descriptor: WorkerCapabilityDescriptor = {
  capabilityId: "fixture.observe",
  summary: "Observe one exact fixture record.",
  effect: "observation",
  controls: {
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string", minLength: 1, maxLength: 128 } },
    required: ["path"],
  },
  selectionControlIds: ["path"],
  controlsRefinement: "mechanical_when_complete",
  catalogGroups: ["files"],
};

export function auditMessages(input: AuditRunnerInput): readonly ChatMessage[] {
  return input.messages as readonly ChatMessage[];
}

export function auditFormatName(input: AuditRunnerInput): string | undefined {
  if (typeof input.format !== "object" || input.format === null)
    return undefined;
  return typeof input.format.name === "string" ? input.format.name : undefined;
}

export function readAuditCapsule<T>(input: AuditRunnerInput, kind: string): T {
  for (const { content } of auditMessages(input)) {
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      continue;
    if ((value as Record<string, unknown>).kind === kind) return value as T;
  }
  throw new Error(`audit_fixture_capsule_missing:${kind}`);
}

export function auditRootPrelude(
  decisionIndex: number,
  recordCount: number,
): unknown {
  if (decisionIndex === 1) {
    return {
      action: "open_capability_scope",
      catalogGroupIds: ["files"],
      acknowledgement: "I will inspect the observations and audit the result.",
    };
  }
  if (decisionIndex === 2) {
    const invocations = Array.from({ length: recordCount }, (_, index) => ({
      capabilityId: descriptor.capabilityId,
      intent: `Observe fixture record ${index + 1}.`,
      selectionControls: { path: `record-${index + 1}.txt` },
    }));
    if (recordCount === 1) {
      return {
        action: "invoke_capability",
        workingDirectory: ".",
        ...invocations[0],
      };
    }
    return {
      action: "invoke_capabilities",
      workingDirectory: ".",
      invocations,
    };
  }
  if (decisionIndex === 3) {
    return { action: "invoke_auditor", criterionIds: AUDIT_CRITERION_IDS };
  }
  throw new Error(`audit_fixture_prelude_exhausted:${decisionIndex}`);
}

export function createAuditorRunnerFixture(
  decide: (input: AuditRunnerInput) => unknown,
  recordCount = 18,
) {
  const records = Array.from({ length: recordCount }, (_, index) => ({
    executionId: `capability-execution-${index + 1}`,
    path: `record-${index + 1}.txt`,
    legacyReferenceData: `LEGACY_SUMMARY_${index + 1}`,
    exactResult: {
      kind: "generic_capability_result_v1" as const,
      authority: "capability_adapter" as const,
      status: "executed" as const,
      ok: true,
      payload: {
        outcome: "succeeded",
        observedEffect: "observation",
        summary: `Observed record ${index + 1}.`,
        referenceData: `EXACT_RECORD_${index + 1}:` + "x".repeat(4_096),
      },
      references: [
        { kind: "tool_target" as const, target: `record-${index + 1}.txt` },
      ],
    },
  }));
  const execute = vi.fn<
    WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
  >(async ({ controls }) => {
    const record = records.find(({ path }) => path === controls.path);
    if (!record) throw new Error("audit_fixture_unknown_record");
    return {
      outcome: "succeeded",
      observedEffect: "observation",
      summary: `Observed ${record.path}.`,
      referenceData: record.legacyReferenceData,
      references: record.exactResult.references,
      exactResult: record.exactResult,
    };
  });
  const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> = {
    descriptor,
    execute,
  };
  const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "execution.response") {
      return { text: AUDIT_RUNNER_FINAL, meta: {} };
    }
    const decision = decide(input);
    return { text: JSON.stringify({ decision }), meta: {} };
  });
  const steps = [
    "execution.decision",
    "execution.response",
    "auditor.decision",
  ];
  const request = createTestRequestExecutionScope({
    requestId: "auditor-evidence-runner",
    sessionId: "auditor-evidence-session",
    prompt: AUDIT_RUNNER_PROMPT,
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    executionPolicySelection: {
      policy: "execution-agent-v1",
      primaryProfileId: "audit-test",
      source: "model_profile",
    },
    runnerConfig: {
      models: { defaults: { profileId: "audit-test", steps: {} } },
      context: {
        outputReserveTokens: 1_000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: Object.fromEntries(
        steps.map((step) => [step, { timeoutMs: 20_000 }]),
      ),
    },
    agentMode: "reasoning",
    modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: {
        "audit-test": {
          provider: "local",
          model: "audit-test",
          contextWindowTokens: 128_000,
        },
      },
      defaults: { profileId: "audit-test", steps: {} },
    },
    modelGatewayClient: { invoke, invokeRaw },
    workerCapabilityProvider: {
      getDescriptors: () => [descriptor],
      getAdapters: () => [adapter],
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
  return { request, records, execute, invoke, invokeRaw };
}
