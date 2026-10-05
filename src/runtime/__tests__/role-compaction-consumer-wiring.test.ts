import { afterEach, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type {
  ChatMessage,
  ModelGatewayPolicyConfig,
} from "../../model-gateway/types.js";
import * as compaction from "../context/model-step-compaction.js";
import { projectRequestToolResults } from "../context/request-tool-results.js";
import type { ModelGatewayClient } from "../ports.js";
import { projectStoredCompletedRoleChild } from "../orchestration/role-calls/index.js";
import { runPlannerGraph } from "../steps/planner-graph/run.js";
import { runSupervisorResponse } from "../steps/supervisor-response/run.js";
import {
  createRootCompactionFixture,
  ACTIVE_FACT,
} from "./support/root-compaction-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  compactContinuation,
  readCompactionEnvelope,
} from "./support/semantic-compaction-contract-fixture.js";
import {
  isSemanticCheckpointMeasurement,
  semanticCompactionReplacementSlots,
} from "./support/semantic-compaction-replacement-fixture.js";

const modelPolicy: ModelGatewayPolicyConfig = {
  providers: { openai: { type: "openai" } },
  profiles: {
    large: {
      provider: "openai",
      model: "large-model",
      contextWindowTokens: 120_000,
    },
    small: {
      provider: "openai",
      model: "small-model",
      contextWindowTokens: 32_000,
    },
  },
  defaults: {
    profileId: "large",
    steps: {
      "supervisor.decision": "small",
      "supervisor.response": "large",
      "planner.decision": "large",
      "planner.graph": "small",
    },
  },
};

afterEach(() => vi.restoreAllMocks());

test("real planner graph runner binds compaction to graph rather than the first allowed step", async () => {
  const fixture = await createRootCompactionFixture("execution-agent-v1", {
    noActiveEvidence: true,
  });
  const opened = await fixture.ledger.apply({
    expectedHead: fixture.head,
    command: {
      authority: "active_role",
      type: "open_child",
      callerCallId: fixture.call.callId,
      roleId: "planner",
      objective: "Plan the bounded report.",
    },
  });
  if (!opened.ok) throw new Error(opened.code);
  const call = fixture.ledger
    .current()
    .state.calls.find((entry) => entry.roleId === "planner")!;
  const controller = vi.spyOn(
    compaction,
    "createModelStepCompactionController",
  );
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: JSON.stringify({
      decision: { action: "decline", reason: "Direct response is sufficient." },
    }),
    meta: {},
  }));
  const request = deriveTestRequestExecutionScope(fixture.request, {
    modelPolicy,
    historyMessages: [],
    sessionMemory: undefined,
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    runnerConfig: {
      ...fixture.request.runnerConfig,
      steps: {
        ...fixture.request.runnerConfig.steps,
        "planner.graph": { timeoutMs: 20_000 },
      },
    },
  });
  expect(await runPlannerGraph(request, call)).toMatchObject({
    outcome: "decline",
  });
  expect(controller.mock.calls[0]![1]).toMatchObject({
    consumer: "planner.graph",
    allowedConsumers: ["planner.decision", "planner.graph"],
  });
  expect(invoke.mock.calls[0]![0].modelStep).toBe("planner.graph");
});

test("real supervisor response repairs a checkpoint rejected only by its smaller decision consumer", async () => {
  const fixture = await createRootCompactionFixture("supervisor-worker-v1", {
    response: true,
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep !== "context.compact") return fixture.invoke(input);
    const envelope = readCompactionEnvelope(
      input.messages as readonly ChatMessage[],
    );
    return {
      text: JSON.stringify({
        continuation: compactContinuation({ currentState: ACTIVE_FACT }),
        sourceDigests: semanticCompactionReplacementSlots(
          envelope,
          () => ACTIVE_FACT,
        ),
      }),
      meta: {},
    };
  });
  let checkpointAttempt = 0;
  const measuredConsumers: string[] = [];
  const countInputTokens = vi.fn<
    NonNullable<ModelGatewayClient["countInputTokens"]>
  >(async (input) => {
    const invocation = resolveModelInvocation(input);
    const checkpoint = isSemanticCheckpointMeasurement(input.messages);
    let inputTokens = 1_000;
    if (checkpoint) {
      measuredConsumers.push(input.modelStep!);
      if (input.modelStep === "supervisor.response") checkpointAttempt++;
      inputTokens = checkpointAttempt === 1 ? 10_000 : 9_000;
    } else if (input.modelStep === "supervisor.response") {
      inputTokens = JSON.stringify(input.messages).includes(
        "runtime_semantic_compaction_checkpoint_v2",
      )
        ? 20_000
        : 100_000;
    }
    return {
      inputTokens,
      profileId: invocation.profile.id,
      provider: invocation.profile.provider,
      model: invocation.model,
      contextWindowTokens: invocation.profile.contextWindowTokens,
      source: "provider_input_token_count",
    };
  });
  const request = deriveTestRequestExecutionScope(fixture.request, {
    modelPolicy,
    historyMessages: [],
    sessionMemory: undefined,
    modelGatewayClient: {
      ...fixture.request.modelGatewayClient,
      invoke,
      countInputTokens,
    },
  });
  const child = projectStoredCompletedRoleChild(
    fixture.head.state,
    {
      callerCallId: fixture.call.callId,
      childCallId: fixture.call.childCallIds[0]!,
    },
    fixture.head.policy,
  );
  const text = await runSupervisorResponse(request, {
    resume: {
      callerCallId: fixture.call.callId,
      invocationAttempt: fixture.call.activationCount,
      returnedChildCallId: child.childCallId,
      returnedResultRef: child.resultRef,
      completedChildren: [child],
    },
    call: {
      rootCallId: fixture.call.callId,
      callId: fixture.call.callId,
      parentCallId: null,
      depth: 0,
      invocationAttempt: fixture.call.activationCount,
    },
    toolResults: projectRequestToolResults({
      ledger: fixture.ledger,
      head: fixture.head,
      callId: fixture.call.callId,
      modelStep: "supervisor.response",
    }),
  });
  expect(text).toBe("The source observation is available.");
  expect(measuredConsumers).toEqual([
    "supervisor.response",
    "supervisor.decision",
    "supervisor.response",
    "supervisor.decision",
  ]);
  expect(
    invoke.mock.calls.filter(
      ([input]) => input.modelStep === "context.compact",
    ),
  ).toHaveLength(2);
  expect(fixture.rootInputs).toHaveLength(1);
  const finalInput = JSON.stringify(fixture.rootInputs[0]);
  expect(finalInput).toContain("runtime_semantic_compaction_checkpoint_v2");
  expect(
    fixture.request.contextCompactionStore!.snapshot!().checkpoints,
  ).toHaveLength(1);
});
