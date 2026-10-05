import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import { StructuredModelInvalidOutputError } from "../model/invoke-structured-step.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { finalizeInvalidRootOutput } from "../request/root-invalid-output.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import {
  createRootInvalidOutputLedger,
  createRootInvalidOutputRequest,
} from "./support/root-invalid-output-fixture.js";
import { mixedWorkerFixture } from "./support/super-mixed-compaction-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function outputFailure() {
  return new StructuredModelInvalidOutputError(
    "invalid_supervisor_decision",
    "supervisor.decision",
    {
      validationStage: "structured_output",
      issues: [],
      repairAttempts: 2,
      repeatedInvalidOutput: true,
    },
  );
}
function registerForeignSource(
  store: ReturnType<typeof createRequestContextCompactionStore>,
) {
  store.registerSources([
    {
      sourceRef: "native-tool:foreign",
      sourceFingerprint: hash("foreign evidence"),
      content: "foreign evidence",
    },
  ]);
}
function phrase() {
  return {
    text: JSON.stringify({
      failureNotice: "Cannot finish.",
      nextStep: "Please try again.",
    }),
    meta: {},
  };
}

test.each(["source", "checkpoint"] as const)(
  "recognized root output failure cannot commit over an incompatible %s",
  async (kind) => {
    const store = createRequestContextCompactionStore();
    if (kind === "source") registerForeignSource(store);
    else store.commit((await mixedWorkerFixture()).checkpoint);
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => phrase());
    const request = createRootInvalidOutputRequest(
      invoke,
      "supervisor-worker-v1",
      { contextCompactionStore: store },
    );
    const ledger = await createRootInvalidOutputLedger();
    const head = ledger.current();
    const error = outputFailure();
    expect(
      await finalizeInvalidRootOutput({
        request,
        ledger,
        expectedHead: head,
        failureStage: "decide",
        steeringVersion: 0,
        error,
      }),
    ).toBeUndefined();
    expect(ledger.current()).toBe(head);
    expect(ledger.current().state.rootResponse).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(request.superFailureFinalization!.primaryError()).toBe(error);
  },
);

test("root failure rechecks source health after explanation authoring before commit", async () => {
  const store = createRequestContextCompactionStore();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
    registerForeignSource(store);
    return phrase();
  });
  const request = createRootInvalidOutputRequest(
    invoke,
    "supervisor-worker-v1",
    { contextCompactionStore: store },
  );
  const ledger = await createRootInvalidOutputLedger();
  const head = ledger.current();
  const error = outputFailure();
  await expect(
    finalizeInvalidRootOutput({
      request,
      ledger,
      expectedHead: head,
      failureStage: "decide",
      steeringVersion: 0,
      error,
    }),
  ).rejects.toBe(error);
  expect(ledger.current()).toBe(head);
  expect(ledger.current().state.rootResponse).toBeNull();
  expect(invoke).toHaveBeenCalledOnce();
});

test("ignored superseded root failure cannot become the primary error of fresh work", async () => {
  const steering = createRequestSteeringInbox({
    requestId: "root-invalid-request",
  });
  steering.append({ steerId: "fresh", text: "Work on the new request." });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const request = createRootInvalidOutputRequest(
    invoke,
    "supervisor-worker-v1",
    { requestSteering: steering },
  );
  const ledger = await createRootInvalidOutputLedger();
  const params = {
    request,
    ledger,
    expectedHead: ledger.current(),
    failureStage: "decide" as const,
  };
  expect(
    await finalizeInvalidRootOutput({
      ...params,
      steeringVersion: 0,
      error: outputFailure(),
    }),
  ).toEqual({ kind: "continue" });
  expect(request.superFailureFinalization!.primaryError()).toBeUndefined();
  const fresh = new Error("current_provider_failure");
  expect(
    await finalizeInvalidRootOutput({
      ...params,
      steeringVersion: 1,
      error: fresh,
    }),
  ).toBeUndefined();
  expect(request.superFailureFinalization!.primaryError()).toBe(fresh);
  expect(invoke).not.toHaveBeenCalled();
});

test("already aborted root failure cannot become a remembered explanation attempt", async () => {
  const abort = new AbortController();
  const cancellation = new Error("request_cancelled");
  abort.abort(cancellation);
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const request = createRootInvalidOutputRequest(
    invoke,
    "supervisor-worker-v1",
    { abortSignal: abort.signal },
  );
  const ledger = await createRootInvalidOutputLedger();
  await expect(
    finalizeInvalidRootOutput({
      request,
      ledger,
      expectedHead: ledger.current(),
      failureStage: "decide",
      steeringVersion: 0,
      error: outputFailure(),
    }),
  ).rejects.toBe(cancellation);
  expect(request.superFailureFinalization!.primaryError()).toBeUndefined();
  expect(invoke).not.toHaveBeenCalled();
});
