import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { resetModelIoTraceConfig } from "../../model-gateway/model-io-trace.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { createRootInvalidOutputLedger } from "./support/root-invalid-output-fixture.js";
import {
  COMPLETE_RAW_BODY, createCompletionDecisionRequest, createCompletionPayloadExecution,
  decisionOutput, mutationDecision,
} from "./support/openai-output-completion-fixture.js";
import { createProviderStreamRetryFixture } from "./support/provider-stream-retry-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  vi.unstubAllEnvs();
  resetModelIoTraceConfig();
  resetDebugLoggerConfig();
});

test.each(["eof", "socket"] as const)("a verified upstream %s retries the same decision and accepts only the complete result", async (ending) => {
  const fixture = await createProviderStreamRetryFixture([
    { text: '{"decision":{"action":"respond","response":"DISCARDED_PARTIAL', ending },
    { text: decisionOutput({ action: "respond", response: "The complete answer." }) },
  ]);
  try {
    const { request, execute } = createCompletionDecisionRequest(fixture);
    const ledger = await createRootInvalidOutputLedger("execution-agent-v1");
    await expect(runRootExecutionKernel({ request, ledger })).resolves.toMatchObject({ output: "The complete answer." });
    expect(fixture.providerRequests).toHaveLength(2);
    expect(fixture.providerRequests[1]).toEqual(fixture.providerRequests[0]);
    expect(execute).not.toHaveBeenCalled();
    expect(ledger.current().state.rootResponse).toBe("The complete answer.");
    expect(JSON.stringify(ledger.current().state)).not.toContain("DISCARDED_PARTIAL");
  } finally {
    await fixture.dispose();
  }
});

test.each(["decision", "response"] as const)("a %s disconnect after a committed capability retries only that model call", async (phase) => {
  const response = { text: "The document was written once." };
  const decision = { text: decisionOutput({ action: "respond" }) };
  const continuation = phase === "decision"
    ? [{ text: '{"decision":{"action":"invoke_capability"', ending: "eof" as const }, decision, response]
    : [decision, { text: "DISCARDED_PARTIAL_ANSWER", ending: "eof" as const }, response];
  const fixture = await createProviderStreamRetryFixture([
    { text: decisionOutput({ action: "open_capability_scope", catalogGroupIds: ["files"] }) },
    { text: decisionOutput(mutationDecision) },
    ...continuation,
  ]);
  try {
    const { request, execute } = createCompletionDecisionRequest(fixture);
    const ledger = await createRootInvalidOutputLedger("execution-agent-v1");
    await expect(runRootExecutionKernel({ request, ledger })).resolves.toMatchObject({ output: "The document was written once." });
    expect(execute).toHaveBeenCalledOnce();
    expect(ledger.current().state.capabilityExecutions).toHaveLength(1);
    expect(fixture.providerRequests).toHaveLength(5);
    const retryIndex = phase === "decision" ? 3 : 4;
    expect(fixture.providerRequests[retryIndex]).toEqual(fixture.providerRequests[retryIndex - 1]);
    expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      "execution.decision", "execution.decision", "execution.decision",
      phase === "decision" ? "execution.decision" : "execution.response", "execution.response",
    ]);
    expect(JSON.stringify(ledger.current().state)).not.toContain("DISCARDED_PARTIAL_ANSWER");
  } finally {
    await fixture.dispose();
  }
});

test("RAW payload recovery writes the accepted bytes once and never writes the first partial payload", async () => {
  const fixture = await createProviderStreamRetryFixture([
    { text: '{"label":"DISCARDED_PARTIAL', ending: "eof" },
    { text: COMPLETE_RAW_BODY },
  ]);
  try {
    const payload = createCompletionPayloadExecution(fixture);
    await expect(payload.run()).resolves.toMatchObject({ outcome: "succeeded", observedEffect: "mutation" });
    expect(payload.execute).toHaveBeenCalledOnce();
    await expect(readFile(payload.target, "utf8")).resolves.toBe(COMPLETE_RAW_BODY);
    expect(fixture.providerRequests).toHaveLength(2);
    expect(fixture.providerRequests[1]).toEqual(fixture.providerRequests[0]);
    expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["tool_payload.raw", "tool_payload.raw"]);
  } finally {
    await fixture.dispose();
  }
});

test("two upstream EOFs exhaust recovery without accepting a decision or executing a capability", async () => {
  const fixture = await createProviderStreamRetryFixture([
    { text: decisionOutput(mutationDecision), ending: "eof" },
    { text: decisionOutput(mutationDecision), ending: "eof" },
  ]);
  try {
    const { request, execute } = createCompletionDecisionRequest(fixture);
    const ledger = await createRootInvalidOutputLedger("execution-agent-v1");
    await expect(runRootExecutionKernel({ request, ledger })).rejects.toThrow("openai function response not completed");
    expect(fixture.providerRequests).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
    expect(ledger.current().state.capabilityExecutions).toEqual([]);
    expect(ledger.current().state.results).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});
