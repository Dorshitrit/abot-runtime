import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayRequest } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/policy/invocation-policy.js";
import { createOpenAIProviderAdapter } from "../../model-gateway/providers/openai/adapter.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { refineExecutionCapabilityInvocations } from "../steps/execution-agent/refinement.js";
import { createWorkerDecisionFormat } from "../steps/worker-decision/format.js";
import { parseWorkerDecisionOutput } from "../steps/worker-decision/parser.js";
import { activeEvidenceCall, createControlsEvidenceFixture, evidenceDescriptor } from "./support/execution-controls-evidence-fixture.js";

beforeEach(() => {
  vi.stubEnv("CONTROLS_TEST_KEY", "fixture-only");
  configureDebugLogger({ enabled: false });
});
afterEach(() => { vi.unstubAllEnvs(); resetDebugLoggerConfig(); });
const policy = {
  providers: { test: { type: "openai", apiKeyEnv: "CONTROLS_TEST_KEY" } },
  profiles: { test: { provider: "test", model: "fixture", contextWindowTokens: 32000 } },
  defaults: { profileId: "test" },
} as const;

async function providerResult(request: ModelGatewayRequest, decision: unknown): Promise<string> {
  const requestBody = { ...request, modelPolicy: policy };
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("text");
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ type: "function", strict: true });
    expect(body.tools[0].parameters).toEqual((request.format as { schema: unknown }).schema);
    const events = [
      { type: "response.output_text.delta", delta: "Do not treat this preamble as controls." },
      { type: "response.completed", response: { status: "completed", output: [{
        type: "function_call", name: body.tool_choice.name, call_id: "call_1", status: "completed",
        arguments: JSON.stringify({ decision }),
      }] } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  const result = await createOpenAIProviderAdapter().invoke({
    endpoint: "raw", requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl,
  });
  if (result.kind !== "raw") throw new Error("expected controls response");
  expect(fetchImpl).toHaveBeenCalledOnce();
  return result.body.text as string;
}

async function refineEa(controls: Record<string, unknown>) {
  const fixture = await createControlsEvidenceFixture();
  fixture.invoke.mockImplementation(async (input) => ({
    text: await providerResult(input, { invocations: { invocation_1: { disposition: "execute", controls } } }),
    meta: {},
  }));
  const head = fixture.ledger.current();
  const result = await refineExecutionCapabilityInvocations(fixture.request, {
    head, call: activeEvidenceCall(head), capabilities: [evidenceDescriptor],
    eligibleSessionArtifactPaths: [], steeringSnapshot: fixture.steering.snapshot(),
    invocations: [{
      capabilityId: evidenceDescriptor.capabilityId, intent: "Read selected evidence.",
      operationObjective: "Use the selected source exactly.",
      selectionControls: { path: "exact.txt" }, controlsEvidenceExecutionIds: [],
    }],
  });
  expect(fixture.ledger.current().state.capabilityExecutions).toHaveLength(0);
  return result;
}

test("EA merges native controls with its frozen selection without executing a capability", async () => {
  const result = await refineEa({ query: "exact query" });
  expect(result.invocations[0]).toMatchObject({
    capabilityId: evidenceDescriptor.capabilityId,
    controls: { path: "exact.txt", query: "exact query" },
  });
});

test.each([{ query: "query", path: "different.txt" }, { query: 42 }, {}])(
  "EA retains domain rejection for native controls %j", async (controls) => {
    await expect(refineEa(controls)).rejects.toThrow();
  },
);

const pending = {
  capabilityId: evidenceDescriptor.capabilityId, intent: "Read selected evidence.",
  selectionControls: { path: "exact.txt" },
};
test.each([false, true])("SUPER preserves native controls and frozen selection, batch=%s", async (batch) => {
  const selections = batch
    ? { pendingCapabilityBatchSelection: [pending, { ...pending, selectionControls: { path: "second.txt" } }] }
    : { pendingCapabilitySelection: pending };
  const format = createWorkerDecisionFormat({
    capabilities: [evidenceDescriptor], maxBatchCapabilityExecutions: 2, ...selections,
  });
  const decision = batch
    ? { action: "invoke_capabilities", invocations: {
      invocation_1: { controls: { query: "first" } }, invocation_2: { controls: { query: "second" } },
    } }
    : { action: "invoke_capability", controls: { query: "first" } };
  const parse = (text: string) => parseWorkerDecisionOutput(text, undefined, {
    availableCapabilities: [evidenceDescriptor], decisionPhase: "capability_execution",
    maxBatchCapabilityExecutions: 2, ...selections,
  });
  const output = await providerResult({ modelStep: "capability.controls", format }, decision);
  const result = parse(output);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error("expected accepted controls");
  const invocations = result.decision.action === "invoke_capabilities" ? result.decision.invocations : [result.decision];
  expect(invocations[0]).toMatchObject({ controls: { path: "exact.txt", query: "first" } });
  if (batch) expect(invocations[1]).toMatchObject({ controls: { path: "second.txt", query: "second" } });
  const invalid = structuredClone(decision);
  if (batch) invalid.invocations!.invocation_1.controls.query = "";
  else invalid.controls!.query = "";
  expect(parse(await providerResult({ modelStep: "capability.controls", format }, invalid))).toMatchObject({ ok: false });
});
