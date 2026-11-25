import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureModelIoTrace, resetModelIoTraceConfig } from "../../model-gateway/model-io-trace.js";
import { renderLlamaCppTemplate } from "../../model-gateway/providers/llamacpp/__tests__/render-template-fixture.js";
import * as debugLogger from "../observability/debug-logger.js";
import { SUPERVISOR_WORKER_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { WORKER_OUTPUT_TYPE_NOTATION } from "../steps/worker-decision/fused-output-contract.js";
import { runWorkerDecision } from "../steps/worker-decision/run.js";
import { createGateway, modelPolicy } from "./support/llamacpp-gateway-fixture.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { INVALID_OUTPUT_RUNNER_CONFIG } from "./support/root-invalid-output-fixture.js";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";

beforeEach(() => {
  vi.spyOn(debugLogger, "traceDebug").mockImplementation(() => {});
  configureModelIoTrace({ enabled: false });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetModelIoTraceConfig(); });

test.each(["all-roles", "first-system-only"] as const)(
  "the same Worker model preserves its complete output contract using the rendered %s layout", async template => {
    const base = await createSuperCompactionSourceFixture("worker-contract-layout", "catalog.txt");
    const gateway = createGateway(template, [JSON.stringify({ decision: {
      assessment: { requiresExecution: false, remaining: "", established: "Catalog observed.",
        evidenceRefs: ["capability-execution-1"] },
      selection: { action: "return_result" },
    } })]);
    const request = createTestRequestExecutionScope({
      ...base.request, runnerConfig: INVALID_OUTPUT_RUNNER_CONFIG, modelPolicy, modelGatewayClient: gateway.client,
      workerCapabilityProvider: base.request.workerCapabilities.provider,
    }, { executionPolicy: SUPERVISOR_WORKER_V1_EXECUTION_POLICY });
    const decision = await runWorkerDecision(request, {
      call: base.call, requestToolResults: base.view,
      capabilitySource: { ledger: base.ledger, head: base.head, binding: Object.freeze({
        requestId: request.requestId, ledger: base.ledger, callId: base.call.callId,
        invocationAttempt: base.call.activationCount, capabilities: Object.freeze([]),
      }) },
    });
    expect(decision.action).toBe("return_result");
    if (decision.action !== "return_result") throw new Error("Expected factual handoff");
    expect(JSON.parse(decision.result)).toMatchObject({ kind: "runtime_worker_execution_report_v1",
      executionOutcomes: [{ executionId: "capability-execution-1", outcome: "succeeded" }] });
    expect(decision.result).toContain("Complete catalog evidence.");

    const counts = gateway.exchanges.filter(exchange => exchange.path === "/input-tokens");
    const sends = gateway.exchanges.filter(exchange => exchange.path === "/chat");
    expect(counts).toHaveLength(1);
    expect(sends).toHaveLength(1);
    const source = sends[0]!.request;
    expect(source.modelStep).toBe("worker.decision");
    expect(source.format).toMatchObject({ name: "worker_evidence_and_selection" });
    expect(counts[0]!.request.messages).toEqual(source.messages);
    const contract = source.messages.at(-1)!;
    expect(contract.role).toBe("system");
    expect(contract.content).toContain(WORKER_OUTPUT_TYPE_NOTATION);
    expect(source.invocationContextMessageIndices).toContain(source.messages.length - 1);
    const measured = counts[0]!.upstream.find(hop => hop.path.endsWith("/input_tokens"))!.payload;
    const sent = sends[0]!.upstream.find(hop => hop.path === "/v1/chat/completions")!.payload;
    expect(sent).toEqual(measured);
    expect(sent.messages.filter(message => message.role !== "system"))
      .toEqual(source.messages.filter(message => message.role !== "system"));
    const rendered = renderLlamaCppTemplate(sent.messages, template);
    expect(rendered.split(contract.content)).toHaveLength(2);
    expect(rendered).toContain("Complete catalog evidence.");
    if (template === "all-roles") {
      expect(sent.messages).toEqual(source.messages);
      expect(sent.messages.at(-1)).toEqual(contract);
    } else {
      expect(sent.messages.filter(message => message.role === "system")).toHaveLength(1);
      expect(sent.messages[0]!.content).toContain(contract.content);
    }

    const diagnostics = vi.mocked(debugLogger.traceDebug).mock.calls
      .filter(([, event]) => event === "llamacpp.template.inspected")
      .map(([, , data]) => data as Record<string, unknown>);
    const selected = diagnostics.filter(data => data.outcome === "preserved");
    expect(selected).toHaveLength(2);
    expect(selected.map(data => data.operation)).toEqual(["count", "invoke"]);
    expect(selected.map(data => data.layout)).toEqual(Array(2).fill(
      template === "all-roles" ? "original" : "context_first_merged"));
    expect(new Set(selected.map(data => data.model))).toEqual(new Set(["invalid-output-test"]));
    if (template === "first-system-only") {
      expect(diagnostics).toContainEqual(expect.objectContaining({
        operation: "count", layout: "original", outcome: "incompatible", reason: "marker_mismatch",
      }));
    } else expect(diagnostics.every(data => data.layout === "original")).toBe(true);
  },
);
