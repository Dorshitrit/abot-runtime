import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { resetModelIoTraceConfig } from "../../model-gateway/model-io-trace.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { createRootInvalidOutputLedger, createRootInvalidOutputRequest } from "./support/root-invalid-output-fixture.js";
import { createCompletionDecisionRequest, decisionOutput, openAICompletionGateway } from "./support/openai-output-completion-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  vi.unstubAllEnvs();
  resetModelIoTraceConfig();
  resetDebugLoggerConfig();
});

test.each(["eof", "done"] as const)("plain EA response ending at %s cannot finish the root or enter format repair", async (ending) => {
  const fixture = await openAICompletionGateway([
    { text: decisionOutput({ action: "respond" }) },
    { text: "The partial answer", ending },
  ]);
  try {
    const { request, execute } = createCompletionDecisionRequest(fixture);
    const ledger = await createRootInvalidOutputLedger("execution-agent-v1");
    await expect(runRootExecutionKernel({ request, ledger })).rejects.toThrow("openai response not completed");
    expect(execute).not.toHaveBeenCalled();
    expect(ledger.current().state.results).toEqual([]);
    expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      "execution.decision", "execution.response",
    ]);
  } finally {
    await fixture.dispose();
  }
});

test.each([false, true])("EA refusal with memory authoring=%s terminates without format-repair calls", async (memoryEnabled) => {
  const fixture = await openAICompletionGateway([
    { text: decisionOutput({ action: "respond" }) },
    { text: "Provider refusal fixture text", refusal: true },
  ]);
  try {
    const request = createRootInvalidOutputRequest(fixture.invoke, "execution-agent-v1", {
      modelPolicy: fixture.modelPolicy, modelGatewayClient: fixture.modelGatewayClient,
      ...(memoryEnabled ? { longTermMemory: {
        enabled: true, retrieve: vi.fn(async () => ({ available: true, records: [] })),
        processCandidates: vi.fn(), scheduleCandidates: vi.fn(), status: vi.fn(),
        list: vi.fn(), search: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn(),
      } } : {}),
    });
    const ledger = await createRootInvalidOutputLedger("execution-agent-v1");
    await expect(runRootExecutionKernel({ request, ledger })).rejects.toThrow("openai response refused");
    expect(ledger.current().state.results).toEqual([]);
    expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      "execution.decision", "execution.response",
    ]);
  } finally {
    await fixture.dispose();
  }
});
