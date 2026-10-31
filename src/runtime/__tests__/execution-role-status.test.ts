import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import { runRequestRunner } from "../request/runner.js";
import { EXECUTION_AGENT_ROLE_EXECUTORS } from "../request/role-executor-composition.js";
import { encodeExecutionAgentAuditObjective, EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID } from "../steps/auditor-decision/index.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRootInvalidOutputLedger, createRootInvalidOutputRequest } from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("EA announces its canonical root before the first model step", async () => {
  const order: string[] = [];
  const onEvent = vi.fn((name: string, payload?: Record<string, unknown>) => {
    if (name === "runtime.state") order.push(String(payload?.stage));
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    order.push(input.modelStep!);
    if (input.modelStep === "execution.decision") return { text: '{"decision":{"action":"respond"}}', meta: {} };
    return { text: "Done.", meta: {} };
  });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", { onEvent });
  expect((await runRequestRunner(request)).output).toBe("Done.");
  expect(order.slice(0, 2)).toEqual(["supervisor", "execution.decision"]);
  expect(onEvent).toHaveBeenCalledWith("runtime.state", expect.objectContaining({ stage: "supervisor", phase: "working" }));
  expect(invoke.mock.calls.every(([input]) => !JSON.stringify(input.messages).includes('"presentationRole"'))).toBe(true);
});

test("the actual Auditor executor announces its canonical review phase, even without usable evidence", async () => {
  const onEvent = vi.fn();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", { onEvent });
  const ledger = await createRootInvalidOutputLedger("execution-agent-v1");
  const callerCall = ledger.current().state.calls.find((call) => call.callId === ledger.current().state.activeCallId)!;
  const result = await EXECUTION_AGENT_ROLE_EXECUTORS.invokeChild({
    requestId: request.requestId, context: request, callerCall, ledger,
    expectedHead: ledger.current(), roleId: "reviewer",
    objective: encodeExecutionAgentAuditObjective([EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID]), turnCount: 0,
  });
  expect(result.execution.kind).toBe("terminal");
  expect(onEvent).toHaveBeenCalledWith("runtime.state", expect.objectContaining({ stage: "reviewer", phase: "reviewing" }));
  expect(invoke).not.toHaveBeenCalled();
});
