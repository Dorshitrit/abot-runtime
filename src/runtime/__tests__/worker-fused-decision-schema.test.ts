import { afterAll, beforeAll, expect, test } from "vitest";
import { projectLlamaCppFormat } from "../../model-gateway/providers/llamacpp/schema-format.js";
import { projectOllamaFormat } from "../../model-gateway/structured-output.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createWorkerFusedDecisionFormat, parseWorkerFusedDecision } from "../steps/worker-decision/fused-decision-format.js";
import { buildWorkerDecisionInput } from "../steps/worker-decision/input.js";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";

const refs = ["capability-execution-1"];
const capabilities = Object.freeze(["example.observe", "example.observe.other"].map((capabilityId) => Object.freeze({
  capabilityId, summary: "Observe the assigned source.", effect: "observation" as const,
  catalogGroups: Object.freeze(["read"] as const),
  controls: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const },
})));
let input: ReturnType<typeof buildWorkerDecisionInput>;
let schema: Record<string, unknown>;

beforeAll(async () => {
  configureDebugLogger({ enabled: false });
  const base = await createSuperCompactionSourceFixture("worker-fused-schema");
  input = buildWorkerDecisionInput(base.request, {
    call: base.call, requestToolResults: base.view,
    capabilitySource: {
      ledger: base.ledger, head: base.head,
      binding: Object.freeze({ requestId: base.request.requestId, ledger: base.ledger,
        callId: base.call.callId, invocationAttempt: base.call.activationCount, capabilities }),
    },
  });
  const format = createWorkerFusedDecisionFormat(input.format, refs);
  const wire = projectLlamaCppFormat(format) as { json_schema: { schema: Record<string, unknown> } };
  schema = wire.json_schema.schema;
  expect(projectOllamaFormat(format).format).toBeDefined();
});
afterAll(() => resetDebugLoggerConfig());

function envelope(requiresExecution: boolean, remaining: string, selection: unknown) {
  return { decision: { assessment: {
    requiresExecution, remaining, evidenceRefs: refs,
    established: "The requested tool supplied the source evidence.",
  }, selection } };
}

function expectAccepted(value: unknown, accepted: boolean) {
  expect(validateJsonSchemaValue(schema, value) === undefined).toBe(accepted);
  expect(parseWorkerFusedDecision(JSON.stringify(value), input, refs).ok).toBe(accepted);
}

// Exact remaining-field snippets from the three rejected 2026-11-23 smoke requests.
test.each([
  "No remaining tasks, the news has been fetched and can now be summarized.",
  "The next step is to summarize the top stories briefly, as per the user's original request.",
  "The results need to be processed to select suitable articles for addition to news.txt.",
])("provider schema rejects the recorded ready-result contradiction: %s", (remaining) => {
  expectAccepted(envelope(false, remaining, { action: "return_result" }), false);
});

test("provider schema and parser preserve valid completion, execution and failure", () => {
  expectAccepted(envelope(false, "", { action: "return_result" }), true);
  expectAccepted(envelope(true, "Observe the missing range.", {
    action: "invoke_capability", capabilityId: capabilities[0]!.capabilityId,
    intent: "Observe the missing range.",
  }), true);
  expectAccepted(envelope(true, "An unavailable source remains.", {
    action: "return_failure", reason: "The required source is unavailable.",
  }), true);
});

test("provider schema and unchanged parser reject mismatched action and assessment", () => {
  expectAccepted(envelope(true, "Observe the missing range.", { action: "return_result" }), false);
  expectAccepted(envelope(false, "", { action: "return_failure", reason: "Missing source." }), false);
  expectAccepted(envelope(true, "", {
    action: "invoke_capability", capabilityId: capabilities[0]!.capabilityId,
    intent: "Observe the missing range.",
  }), false);
});
