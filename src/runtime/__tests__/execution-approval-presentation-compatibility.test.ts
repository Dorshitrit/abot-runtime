import { afterEach, beforeEach, expect, test } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import type { RequestApprovalContinuation } from "../request/approval-continuation.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { rebindTestRequestExecutionPolicy } from "./support/request-execution-scope.js";
import {
  actionFingerprint,
  createApprovalRunnerFixture,
} from "./support/request-approval-runner-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function fixture(intent?: unknown) {
  const f = createApprovalRunnerFixture();
  f.decide.mockImplementationOnce(async () => ({
    steeringVersion: 0,
    decision: {
      action: "invoke_capability",
      capabilityId: "fixture.observe",
      controls: {},
      ...(intent !== undefined ? { intent: intent as string } : {}),
    },
  }));
  // Script only the root decision; retain EA authority and the durable runner.
  const policy = {
    ...EXECUTION_AGENT_V1_EXECUTION_POLICY,
    rootContract: {
      ...EXECUTION_AGENT_V1_EXECUTION_POLICY.rootContract,
      decide: f.decide,
    },
  };
  const request = () =>
    rebindTestRequestExecutionPolicy(f.makeRequest(), policy);
  const start = () => runRequestRunner(request(), { durableApproval: true });
  const resume = (continuation: RequestApprovalContinuation) =>
    runRequestRunner(request(), {
      durableApproval: true,
      continuation,
      decisions: [{
        approvalId: "approval-exact",
        actionFingerprint,
        decision: { approved: true },
      }],
    });
  return { ...f, start, resume };
}

async function park(f: ReturnType<typeof fixture>) {
  const waiting = await f.start();
  if (waiting.kind !== "awaiting_approval")
    throw new Error("expected durable approval wait");
  expect(f.performed).not.toHaveBeenCalled();
  expect(f.onAnswerToken).not.toHaveBeenCalled();
  expect(f.onAcknowledgement).not.toHaveBeenCalled();
  const continuation = JSON.parse(JSON.stringify(waiting.continuation)) as
    RequestApprovalContinuation;
  expect(continuation).toEqual(waiting.continuation);
  expect(continuation.ledger.policy.authority).toEqual(
    EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
  );
  return continuation;
}

test("EA approval saves and resumes an absent presentation intent without synthesizing one", async () => {
  const f = fixture();
  const continuation = await park(f);
  expect(continuation.preparedGroup.entries[0]).not.toHaveProperty("intent");
  expect(continuation.ledger.state.capabilityExecutions[0]).not.toHaveProperty("intent");
  const serialized = JSON.stringify(continuation);
  expect(await f.resume(continuation)).toMatchObject({
    kind: "completed",
    result: { output: "Finished: succeeded." },
  });
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.restore).toHaveBeenCalledOnce();
  expect(f.restore.mock.calls[0]![0]).not.toHaveProperty("intent");
  expect(f.executed).toHaveBeenCalledOnce();
  expect(f.performed).toHaveBeenCalledExactlyOnceWith(
    "capability-execution-1", "original",
  );
  expect(f.onAcknowledgement).not.toHaveBeenCalled();
  expect(JSON.stringify(continuation)).toBe(serialized);
});

test("a legacy EA intent-bearing approval retains exact admitted text and executes once", async () => {
  const intent = 'Inspect the original "target".\nKeep this saved receipt.';
  const f = fixture(`  ${intent}  `);
  const continuation = await park(f);
  expect(continuation.preparedGroup.entries[0]?.intent).toBe(intent);
  expect(continuation.ledger.state.capabilityExecutions[0]?.intent).toBe(intent);
  const serialized = JSON.stringify(continuation);
  expect(await f.resume(continuation)).toMatchObject({ kind: "completed" });
  expect(f.restore.mock.calls[0]![0]).toMatchObject({ intent });
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.restore).toHaveBeenCalledOnce();
  expect(f.executed).toHaveBeenCalledOnce();
  expect(f.performed).toHaveBeenCalledExactlyOnceWith(
    "capability-execution-1", "original",
  );
  expect(JSON.stringify(continuation)).toBe(serialized);
});

test.each([null, 42, {}, "", " \n ", "x".repeat(501)])(
  "rejects malformed supplied presentation intent %j before preparation or effect",
  async (intent) => {
    const f = fixture(intent);
    await expect(f.start()).rejects.toThrow();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.executed).not.toHaveBeenCalled();
    expect(f.performed).not.toHaveBeenCalled();
  },
);

test.each([undefined, "Changed saved intent."])(
  "rejects a legacy approval whose group intent no longer matches the ledger (%s)",
  async (replacement) => {
    const f = fixture("Original saved intent.");
    const continuation = await park(f);
    const entry = continuation.preparedGroup.entries[0]!;
    const { intent: _intent, ...withoutIntent } = entry;
    const changed: RequestApprovalContinuation = {
      ...continuation,
      preparedGroup: {
        ...continuation.preparedGroup,
        entries: [{
          ...withoutIntent,
          ...(replacement !== undefined ? { intent: replacement } : {}),
        }],
      },
    };
    await expect(f.resume(changed)).rejects.toThrow();
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.executed).not.toHaveBeenCalled();
    expect(f.performed).not.toHaveBeenCalled();
  },
);
