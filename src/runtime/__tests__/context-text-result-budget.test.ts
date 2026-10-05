import { afterEach, expect, test } from "vitest";
import type { ToolImplementationOutput } from "../../plugin-sdk/index.js";
import { enforcePluginResultByteBudget } from "../../plugin-sdk/results.js";
import { CAPABILITY_RESULT_ENVELOPE_MAX_BYTES } from "../../capabilities/result-budget.js";
import { projectToolExecutionResult } from "../../capabilities/tool-result-normalization.js";
import { buildToolCompletedEventActions } from "../../capabilities/tool-event-metadata.js";
import { createRegisteredToolResultBudget } from "../adapters/registered-tool-normal-invocations/execution/result-budget.js";
import { observeExternalResult } from "../adapters/registered-tool-worker-capabilities/result-observer.js";
import { normalizeCapabilityAdapterResult } from "../orchestration/capability-adapters/result.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { assessRequestMessagesBudget } from "../context/request-context-budget.js";
import { requiresContextCompaction } from "../model/context-compaction-admission.js";
import { createExecCommandPathFixture } from "./support/exec-command-path-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

const exactText = 'שלום\\"\n🚀'.repeat(30_000);
const output = {
  ok: true,
  output: "completed",
  stdout: exactText,
  contextTextFields: ["stdout"] as const,
  producedNewInformation: true,
};
afterEach(disposeCompositionFixtures);

async function resultContract() {
  const fixture = await createExecCommandPathFixture();
  const call = { tool: "exec", params: { cwd: ".", command: "fixture" } };
  const definition = fixture.registry.getDefinition("exec")!;
  const selectedReferences = [{ kind: "tool_target" as const, target: "." }];
  const budget = createRegisteredToolResultBudget({
    call,
    definition,
    selectedReferences,
  });
  return { call, definition, selectedReferences, budget };
}

test("counts escaped Unicode correctly and enforces the final canonical metadata boundary", async () => {
  const { budget } = await resultContract();
  const empty = { ...output, data: { padding: "" } };
  const base = budget.assess(empty);
  expect(base.serializedBytes).toBeGreaterThan(
    CAPABILITY_RESULT_ENVELOPE_MAX_BYTES,
  );
  expect(base.contextTextBytes).toBe(
    Buffer.byteLength(JSON.stringify(exactText)) - 2,
  );
  const paddingLength =
    CAPABILITY_RESULT_ENVELOPE_MAX_BYTES - base.envelopeBytes!;
  const atLimit = { ...empty, data: { padding: "x".repeat(paddingLength) } };
  const above = { ...empty, data: { padding: "x".repeat(paddingLength + 1) } };
  expect(budget.assess(atLimit)).toMatchObject({
    fits: true,
    envelopeBytes: CAPABILITY_RESULT_ENVELOPE_MAX_BYTES,
  });
  expect(enforcePluginResultByteBudget(atLimit, budget)).toBe(atLimit);
  expect(budget.assess(above)).toMatchObject({
    fits: false,
    envelopeBytes: CAPABILITY_RESULT_ENVELOPE_MAX_BYTES + 1,
  });
  expect(enforcePluginResultByteBudget(above, budget).errorCode).toBe(
    "plugin_result_too_large",
  );
});

test("keeps exact text in canonical evidence and presents it to the existing 32K compaction gate", async () => {
  const { call, definition, selectedReferences, budget } =
    await resultContract();
  expect(enforcePluginResultByteBudget(output, budget)).toBe(output);
  const result = projectToolExecutionResult("exec", output);
  const completionActions = buildToolCompletedEventActions(
    call,
    result,
    definition,
  );
  const observed = observeExternalResult(
    { status: "executed", effect: "mixed", result, completionActions },
    "mixed",
    true,
    selectedReferences,
  );
  const exact = observed.result.exactResult;
  expect(
    normalizeCapabilityAdapterResult(JSON.parse(JSON.stringify(exact))).ok,
  ).toBe(true);
  const source = createCapabilityResultCompactionSource({
    executionId: "output-execution",
    callId: "output-root",
    invocationAttempt: 1,
    capabilityId: "exec.execute_command",
    declaredEffect: "mixed",
    outcome: observed.result.outcome,
    observedEffect: observed.result.observedEffect,
    summary: observed.result.summary,
    adapterResult: exact,
  });
  expect(
    JSON.parse(source.content).adapterResult.result.stdout === exactText,
  ).toBe(true);
  const assessment = assessRequestMessagesBudget({
    messages: [{ role: "user", content: source.content }],
    budget: {
      contextWindowTokens: 32_000,
      outputReserveTokens: 4096,
      safetyReserveTokens: 1024,
      attachmentReserveTokens: 0,
    },
  });
  expect(requiresContextCompaction(true, assessment)).toBe(true);
});

test("leaves ordinary delivery unchanged and requires host support for context text", async () => {
  const { budget } = await resultContract();
  const ordinary = { ok: true, output: "small", producedNewInformation: true };
  expect(enforcePluginResultByteBudget(ordinary, budget)).toBe(ordinary);
  expect(enforcePluginResultByteBudget(output).errorCode).toBe(
    "plugin_context_text_unavailable",
  );
  const { contextTextFields: _declaration, ...legacy } = output;
  expect(enforcePluginResultByteBudget(legacy).errorCode).toBe(
    "plugin_result_too_large",
  );
});

test.each([
  { fields: [] },
  { fields: ["stdout", "stdout"] },
  { fields: ["data"] },
  { fields: ["stderr"] },
])("rejects malformed context-text declarations: %j", async ({ fields }) => {
  const { budget } = await resultContract();
  const invalid = {
    ...output,
    contextTextFields: fields,
  } as unknown as ToolImplementationOutput;
  expect(enforcePluginResultByteBudget(invalid, budget).errorCode).toBe(
    "plugin_context_text_invalid",
  );
});
