import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureModelIoTrace, resetModelIoTraceConfig } from "../../model-gateway/model-io-trace.js";
import { renderLlamaCppTemplate } from "../../model-gateway/providers/llamacpp/__tests__/render-template-fixture.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { SUPERVISOR_WORKER_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { runWorkerDecision } from "../steps/worker-decision/run.js";
import { createGateway, modelPolicy } from "./support/llamacpp-gateway-fixture.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { INVALID_OUTPUT_RUNNER_CONFIG } from "./support/root-invalid-output-fixture.js";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";

beforeEach(() => { configureDebugLogger({ enabled: false }); configureModelIoTrace({ enabled: false }); });
afterEach(() => { vi.unstubAllGlobals(); resetDebugLoggerConfig(); resetModelIoTraceConfig(); });

test.each(["first-system-only", "all-roles"] as const)(
  "a Worker can repair an inconsistent assessment after a settled capability on %s", async template => {
    const base = await createSuperCompactionSourceFixture("worker-repair-with-evidence", "catalog.txt");
    const rejectedSummary = "Rejected candidate which must never become evidence.";
    const evidenceRefs = ["capability-execution-1"];
    const invalid = { requiresExecution: true, remaining: "", established: rejectedSummary, evidenceRefs };
    const corrected = { requiresExecution: false, remaining: "", established: "Catalog observed.", evidenceRefs };
    const result = "The catalog is available.";
    const gateway = createGateway(template, [
      JSON.stringify({ decision: invalid }), JSON.stringify({ decision: corrected }), result,
    ]);
    const request = createTestRequestExecutionScope({
      ...base.request, runnerConfig: INVALID_OUTPUT_RUNNER_CONFIG, modelPolicy, modelGatewayClient: gateway.client,
      workerCapabilityProvider: base.request.workerCapabilities.provider,
    }, { executionPolicy: SUPERVISOR_WORKER_V1_EXECUTION_POLICY });
    const binding = Object.freeze({
      requestId: request.requestId, ledger: base.ledger, callId: base.call.callId,
      invocationAttempt: base.call.activationCount, capabilities: Object.freeze([]),
    });
    await expect(runWorkerDecision(request, {
      call: base.call, requestToolResults: base.view, capabilitySource: { ledger: base.ledger, head: base.head, binding },
    })).resolves.toEqual({ action: "return_result", result });
    expect(base.ledger.current()).toBe(base.head);

    const sends = gateway.exchanges.filter(exchange => exchange.path === "/chat");
    expect(sends.map(exchange => exchange.request.modelStep)).toEqual(["worker.evidence", "worker.evidence", "worker.result"]);
    const [first, repair] = sends;
    const evidence = first!.request.messages.filter(message => message.role !== "system");
    expect(JSON.stringify(evidence)).toContain("Complete catalog evidence.");
    expect(repair!.request.messages.filter(message => message.role !== "system")).toEqual(evidence);
    const validatorCode = "worker_evidence_assessment_invalid";
    for (const exchange of [first!, repair!]) {
      const counted = gateway.exchanges.find(candidate =>
        candidate.path === "/input-tokens" && isDeepStrictEqual(candidate.request, exchange.request));
      const measured = counted?.upstream.find(hop => hop.path.endsWith("/input_tokens"))?.payload;
      const sent = exchange.upstream.find(hop => hop.path === "/v1/chat/completions")!.payload;
      expect(measured).toEqual(sent);
      const frames = renderLlamaCppTemplate(sent.messages, template);
      expect(frames).not.toContain(rejectedSummary);
      expect(frames.split(validatorCode).length - 1).toBe(exchange === repair ? 1 : 0);
      if (exchange === repair) {
        const guidance = sent.messages.find(message => message.content.includes(validatorCode))!;
        expect(guidance.role).toBe("system");
        expect(frames.indexOf(validatorCode)).toBeLessThan(frames.indexOf("<|start|>user<|message|>"));
      }
    }
  },
);
