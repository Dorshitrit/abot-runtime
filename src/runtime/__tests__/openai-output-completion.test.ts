import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { resetModelIoTraceConfig } from "../../model-gateway/model-io-trace.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { createRootInvalidOutputLedger } from "./support/root-invalid-output-fixture.js";
import {
  COMPLETE_RAW_BODY, createCompletionDecisionRequest, createCompletionPayloadExecution,
  decisionOutput, mutationDecision, openAICompletionGateway,
} from "./support/openai-output-completion-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  vi.unstubAllEnvs();
  resetModelIoTraceConfig();
  resetDebugLoggerConfig();
});

test.each(["eof", "done"] as const)("valid decision ending at %s cannot execute a capability", async (ending) => {
  const fixture = await openAICompletionGateway([
    { text: decisionOutput({ action: "open_capability_scope", catalogGroupIds: ["files"], acknowledgement: "I will write the document." }) },
    { text: decisionOutput(mutationDecision), ending },
  ]);
  try {
    const { request, execute } = createCompletionDecisionRequest(fixture);
    const ledger = await createRootInvalidOutputLedger("execution-agent-v1");
    await expect(runRootExecutionKernel({ request, ledger })).rejects.toThrow("openai function response not completed");
    expect(execute).not.toHaveBeenCalled();
    expect(ledger.current().state.capabilityExecutions).toEqual([]);
    expect(ledger.current().state.results).toEqual([]);
    expect(fixture.invoke).toHaveBeenCalledTimes(2);
    expect(ledger.current().state.calls[0]!.workerCapabilityScope)
      .toEqual({ catalogGroupIds: ["files"] });
  } finally {
    await fixture.dispose();
  }
});

test("the same completed decision executes the capability and finishes normally", async () => {
  const fixture = await openAICompletionGateway([
    { text: decisionOutput({ action: "open_capability_scope", catalogGroupIds: ["files"], acknowledgement: "I will write the document." }) },
    { text: decisionOutput(mutationDecision) },
    { text: decisionOutput({ action: "respond" }) },
    { text: "The document was written." },
  ]);
  try {
    const { request, execute } = createCompletionDecisionRequest(fixture);
    const ledger = await createRootInvalidOutputLedger("execution-agent-v1");
    await expect(runRootExecutionKernel({ request, ledger })).resolves.toMatchObject({ output: "The document was written." });
    expect(execute).toHaveBeenCalledOnce();
    expect(ledger.current().state.capabilityExecutions).toHaveLength(1);
    expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      "execution.decision", "execution.decision", "execution.decision", "execution.response",
    ]);
  } finally {
    await fixture.dispose();
  }
});

test.each(["eof", "done"] as const)("valid RAW ending at %s cannot reach a registered file mutation", async (ending) => {
  expect(JSON.parse(COMPLETE_RAW_BODY)).toEqual({ label: "complete content", count: 2 });
  const fixture = await openAICompletionGateway([{ text: COMPLETE_RAW_BODY, ending }]);
  try {
    const payload = createCompletionPayloadExecution(fixture);
    await expect(payload.run()).resolves.toMatchObject({
      outcome: "failed", observedEffect: "none",
      exactResult: { code: "payload_model_invocation_failed", stage: "before_external_execution" },
    });
    expect(payload.execute).not.toHaveBeenCalled();
    await expect(readFile(payload.target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.invoke).toHaveBeenCalledOnce();
    expect(fixture.invoke.mock.calls[0]![0].modelStep).toBe("tool_payload.raw");
  } finally {
    await fixture.dispose();
  }
});

test("the same completed RAW reaches the registered mutation with exact bytes", async () => {
  const fixture = await openAICompletionGateway([{ text: COMPLETE_RAW_BODY }]);
  try {
    const payload = createCompletionPayloadExecution(fixture);
    await expect(payload.run()).resolves.toMatchObject({ outcome: "succeeded", observedEffect: "mutation" });
    expect(payload.execute).toHaveBeenCalledOnce();
    await expect(readFile(payload.target, "utf8")).resolves.toBe(COMPLETE_RAW_BODY);
    expect(fixture.invoke).toHaveBeenCalledOnce();
  } finally {
    await fixture.dispose();
  }
});
