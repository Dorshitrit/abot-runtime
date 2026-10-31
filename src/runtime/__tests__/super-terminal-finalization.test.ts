import { ModelOutputIncompleteError } from "../model/provider-completion.js";
import { withSupervisorPreparation, supervisorFormatName } from "./support/supervisor-model-phases.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import type { ModelGatewayClient } from "../ports.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { buildDegradedFinalizationFallback } from "../steps/degraded-finalization/fallback.js";
import {
  createRootInvalidOutputLedger,
  createRootInvalidOutputRequest,
  rootRespondOutput,
} from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

const fallback = buildDegradedFinalizationFallback({
  problem: {
    stage: "provider_completion",
    code: "output_incomplete",
  },
  progress: null,
});

function unknownCompletion() {
  return new ModelOutputIncompleteError({
    outputLength: 0, providerCompletionReason: "unknown",
  }, "supervisor.decision");
}

test("SUPER known invalid output commits one blocked notice without invoking a finalizer", async () => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async () => ({
    text: "invalid", meta: {},
  })));
  const request = createRootInvalidOutputRequest(invoke);
  const ledger = await createRootInvalidOutputLedger();
  const result = await runRootExecutionKernel({ request, ledger });
  expect(result.disposition).toBe("blocked");
  expect(result.output).toContain("model returned an invalid decision or response");
  expect(ledger.current().state.rootResponse).toBe(result.output);
  expect(ledger.current().state.capabilityExecutions).toEqual([]);
  expect(invoke.mock.calls.filter(([input]) => input.modelStep === "degraded.finalization")).toEqual([]);
});

test.each(["invalid", "provider_failure"] as const)(
  "SUPER unknown-cause %s finalizer makes one attempt and commits a blocked fallback",
  async (outcome) => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
      if (input.modelStep !== "degraded.finalization") throw unknownCompletion();
      if (outcome === "provider_failure") throw new Error("provider_connection_failed");
      return { text: "invalid", meta: {} };
    }));
    const request = createRootInvalidOutputRequest(invoke);
    const ledger = await createRootInvalidOutputLedger();
    const result = await runRootExecutionKernel({ request, ledger });
    expect(result).toMatchObject({ output: fallback, disposition: "blocked" });
    expect(result.finalObservation).toBeUndefined();
    expect(result.memoryCandidates).toBeUndefined();
    expect(
      invoke.mock.calls.filter(
        ([input]) => input.modelStep === "degraded.finalization",
      ),
    ).toHaveLength(1);
    expect(ledger.current().state.rootResponse).toBe(fallback);
    expect(request.superFailureFinalization!.primaryError()).toMatchObject({
      name: "ModelOutputIncompleteError",
      modelStep: "supervisor.decision",
      providerCompletionReason: "unknown",
    });
  },
);

test("SUPER discards stale finalizer phrasing without replenishing its authoring budget", async () => {
  const steering = createRequestSteeringInbox({
    requestId: "root-invalid-request",
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
    if (input.modelStep === "degraded.finalization") {
      steering.append({
        steerId: "new-direction",
        text: "Follow this updated direction.",
      });
      return {
        text: JSON.stringify({ failureNotice: "STALE", nextStep: "STALE" }),
        meta: {},
      };
    }
    throw unknownCompletion();
  }));
  const request = createRootInvalidOutputRequest(
    invoke,
    "supervisor-worker-v1",
    { requestSteering: steering },
  );
  const ledger = await createRootInvalidOutputLedger();
  const result = await runRootExecutionKernel({ request, ledger });
  expect(result).toMatchObject({ output: fallback, disposition: "blocked" });
  expect(
    invoke.mock.calls.filter(
      ([input]) => input.modelStep === "degraded.finalization",
    ),
  ).toHaveLength(1);
  expect(result.output).not.toContain("STALE");
});

test("SUPER still accepts healthy work after finalizer steering invalidation", async () => {
  const steering = createRequestSteeringInbox({
    requestId: "root-invalid-request",
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
    if (input.modelStep === "degraded.finalization") {
      steering.append({ steerId: "fresh", text: "Answer the new direction." });
      return {
        text: JSON.stringify({ failureNotice: "STALE", nextStep: "STALE" }),
        meta: {},
      };
    }
    const isInitialDecision = input.modelStep === "supervisor.decision" && steering.snapshot().version === 0;
    if (isInitialDecision) throw unknownCompletion();
    if (input.modelStep === "supervisor.decision")
      return { text: rootRespondOutput("supervisor-worker-v1"), meta: {} };
    return { text: "Current answer", meta: {} };
  }));
  const request = createRootInvalidOutputRequest(
    invoke,
    "supervisor-worker-v1",
    { requestSteering: steering },
  );
  const ledger = await createRootInvalidOutputLedger();
  expect(await runRootExecutionKernel({ request, ledger })).toMatchObject({
    output: "Current answer",
  });
  expect(
    invoke.mock.calls.filter(
      ([input]) => input.modelStep === "degraded.finalization",
    ),
  ).toHaveLength(1);
});

test("SUPER never fabricates a role commit when the response limit cannot hold a complete notice", async () => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async () => ({
    text: "invalid",
    meta: {},
  })));
  const request = createRootInvalidOutputRequest(invoke);
  const ledger = await createRootInvalidOutputLedger("supervisor-worker-v1", 8);
  const head = ledger.current();
  await expect(
    runRootExecutionKernel({ request, ledger }),
  ).rejects.toMatchObject({ message: "invalid_supervisor_decision" });
  expect(ledger.current()).toBe(head);
  expect(ledger.current().state.rootResponse).toBeNull();
  expect(
    invoke.mock.calls.filter(
      ([input]) => input.modelStep === "degraded.finalization",
    ).length,
  ).toBeLessThanOrEqual(1);
});

test("a root compaction read failure permits fresh classification but blocks history-dependent response", async () => {
  const canonicalStore = createRequestContextCompactionStore();
  const store = {
    ...canonicalStore,
    get: vi.fn(canonicalStore.get).mockImplementationOnce(() => {
      throw new Error("context_compaction_checkpoint_invalid");
    }),
  };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async () => ({
    text: JSON.stringify({
      failureNotice: "Cannot finish this request.",
      nextStep: "Please try again.",
    }),
    meta: {},
  }), { classifyProcedure: () => ({ requiresProcedure: false }) }));
  const request = createRootInvalidOutputRequest(
    invoke,
    "supervisor-worker-v1",
    {
      contextCompactionStore: store,
      historyMessages: [{
        id: "previous-user", role: "user", content: "PRIVATE_PREVIOUS_HISTORY",
        createdAt: "2026-10-17T00:00:00.000Z",
      }],
    },
  );
  const ledger = await createRootInvalidOutputLedger();
  const result = await runRootExecutionKernel({ request, ledger });
  expect(result).toMatchObject({ disposition: "blocked" });
  expect(result.output).toContain("Cannot finish this request.");
  expect(invoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual([
    "supervisor_presentation",
    "supervisor_procedure_gate",
    "degraded.finalization",
  ]);
  expect(JSON.stringify(invoke.mock.calls[0]![0].messages)).not.toContain("PRIVATE_PREVIOUS_HISTORY");
  expect(ledger.current().state.calls).toHaveLength(1);
  expect(ledger.current().state.capabilityExecutions).toEqual([]);
  expect(ledger.current().state.rootResponse).toBe(result.output);
  expect(request.superFailureFinalization!.primaryError()).toMatchObject({
    name: "SuperContextFailure",
    code: "context_compaction_checkpoint_invalid",
  });
  expect(store.snapshot!()).not.toHaveProperty("invalidatedScopes");
});
