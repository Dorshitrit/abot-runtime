import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildOpenAIResponsesPayload } from "../../model-gateway/providers/openai/payload.js";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { activeEvidenceCall, createControlsEvidenceFixture, runtimeCapsule } from "./support/execution-controls-evidence-fixture.js";
import { executionPrefixCachePolicy } from "./support/execution-prefix-cache-fixture.js";
import { stableDecisionVariants, type DecisionSchemaNode } from "./support/stable-decision-fixture.js";

type Fixture = Awaited<ReturnType<typeof createControlsEvidenceFixture>>;

function input(fixture: Fixture, request: RequestExecutionScope = fixture.request, includeTitle = false) {
  const head = fixture.ledger.current();
  return buildExecutionAgentInput(request, {
    head, call: activeEvidenceCall(head), steeringSnapshot: fixture.steering.snapshot(),
    includeAcknowledgement: includeTitle, includeTitle, allowPlanner: true, allowAuditor: true,
  });
}

function payload(fixture: Fixture, value: ReturnType<typeof input>) {
  return buildOpenAIResponsesPayload({
    modelPolicy: fixture.request.modelPolicy,
    agentMode: fixture.request.agentMode,
    modelStep: value.modelStep,
    messages: [...value.messages],
    format: value.format,
    promptCacheScope: fixture.request.sessionId,
    promptCacheBoundaryBeforeMessageIndex: value.messages.indexOf(value.promptCacheBoundaryBeforeMessage!),
  });
}

// A cache breakpoint is transport metadata, not prompt content. The moving endpoint
// may differ; every rendered input byte before it must retain its original meaning.
function promptItems(value: unknown): unknown[] {
  return JSON.parse(JSON.stringify(value, (key, item) => key === "prompt_cache_breakpoint" ? undefined : item));
}

function withoutPresentationFields(schema: DecisionSchemaNode): DecisionSchemaNode {
  const result = structuredClone(schema);
  for (const variant of stableDecisionVariants(result)) {
    delete variant.properties!.title;
    delete variant.properties!.acknowledgement;
    variant.required = variant.required!.filter((field) => field !== "title" && field !== "acknowledgement");
  }
  return result;
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("EA provider prompt cache contract", () => {
  test("keeps exact tools and policy while evidence and execution limits change at the same field availability", async () => {
    const fixture = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy }, 4);
    await fixture.addResult("Initial settled evidence establishes post-execution field availability.");
    const first = input(fixture);
    await fixture.addResult("FIRST exact result");
    const second = input(fixture);
    await fixture.addResult("SECOND exact result", { failed: true });
    const third = input(fixture);
    const inputs = [first, second, third];
    const payloads = inputs.map((value) => payload(fixture, value));
    for (const current of payloads.slice(1)) {
      expect(JSON.stringify(current.tools)).toBe(JSON.stringify(payloads[0]!.tools));
      expect(JSON.stringify((current.input as unknown[])[0])).toBe(JSON.stringify((payloads[0]!.input as unknown[])[0]));
      expect(current.prompt_cache_key).toBe(payloads[0]!.prompt_cache_key);
    }
    expect(inputs.map(({ contract }) => contract.maxBatchCapabilityExecutions)).toEqual([3, 2, 1]);
    expect(inputs.map(({ contract }) => contract.eligibleControlsEvidenceExecutionIds?.length)).toEqual([1, 2, 3]);
    for (let index = 1; index < inputs.length; index++) {
      const previous = inputs[index - 1]!;
      const current = inputs[index]!;
      const prefixEnd = previous.messages.indexOf(previous.promptCacheBoundaryBeforeMessage!);
      expect(promptItems(payloads[index]!.input).slice(0, prefixEnd))
        .toEqual(promptItems(payloads[index - 1]!.input).slice(0, prefixEnd));
      const boundary = current.messages.indexOf(current.promptCacheBoundaryBeforeMessage!);
      expect(boundary).toBeGreaterThan(prefixEnd);
      expect(current.messages.at(-1)?.role).toBe("tool");
      const previousResult = previous.messages.filter(({ role }) => role === "tool").at(-1)!;
      expect(current.messages.slice(0, boundary)).toContainEqual(previousResult);
      expect(current.messages.slice(boundary)).not.toContainEqual(previousResult);
    }
    for (const current of inputs) {
      expect(current.contract.directResponseMaxLength).toBeUndefined();
      expect(current.contract.allowAuditor).toBe(true);
      expect(current.contract.includeWorkingDirectory).toBe(true);
      validateModelGatewayMessages(current.messages);
      expect(current.messages.filter(({ content }) => content === fixture.request.prompt)).toHaveLength(1);
      const capsule = runtimeCapsule(current.messages, "runtime_execution_decision_contract_v1");
      expect(capsule).toMatchObject({ authority: "runtime_state", limits: { maxBatchCapabilityExecutions: current.contract.maxBatchCapabilityExecutions } });
    }
  });

  test("keeps the registry before growing history across user turns, with time in the changing suffix", async () => {
    const fixture = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
    const firstRequest = { ...fixture.request, prompt: "First exact user request.", temporalContext: {
      currentDateTime: "2026-11-22 10:00:00", timeZone: "Asia/Jerusalem",
    } } as RequestExecutionScope;
    const first = input(fixture, firstRequest, true);
    const samePresentation = input(fixture, firstRequest);
    const second = input(fixture, { ...firstRequest,
      prompt: "Second exact user request.",
      temporalContext: { ...firstRequest.temporalContext!, currentDateTime: "2026-11-22 10:01:00" },
      historyMessages: [
        { id: "prior-user", role: "user", content: firstRequest.prompt, createdAt: "2026-11-22T08:00:00Z" },
        { id: "prior-assistant", role: "assistant", content: "First settled answer.", createdAt: "2026-11-22T08:00:05Z" },
      ],
    });
    const a = payload(fixture, first), b = payload(fixture, second);
    expect(JSON.stringify(payload(fixture, samePresentation).tools)).toBe(JSON.stringify(b.tools));
    expect(a.tools).not.toEqual(b.tools);
    expect(withoutPresentationFields(first.format.schema)).toEqual(samePresentation.format.schema);
    const aItems = promptItems(a.input), bItems = promptItems(b.input);
    expect(JSON.stringify(aItems.slice(0, 3))).toBe(JSON.stringify(bItems.slice(0, 3)));
    expect(first.messages[1]?.content).toMatch(/^Tool groups:/);
    expect(second.messages[1]?.content).toBe(first.messages[1]?.content);
    expect(second.messages[2]?.content).toBe(firstRequest.prompt);
    const timeIndex = second.messages.findIndex(({ content }) => content.includes('"kind":"runtime_request_time_v1"'));
    expect(timeIndex).toBeGreaterThan(second.messages.findIndex(({ content }) => content === "Second exact user request."));
    expect(runtimeCapsule(first.messages, "runtime_execution_decision_contract_v1")).toMatchObject({ includeTitle: true });
    expect(runtimeCapsule(second.messages, "runtime_execution_decision_contract_v1")).toMatchObject({ includeTitle: false });
  });

  test("keeps invocation context after the user and retains its system authority", async () => {
    const fixture = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
    const before = input(fixture);
    const head = fixture.ledger.current();
    const after = buildExecutionAgentInput(fixture.request, {
      head, call: activeEvidenceCall(head), steeringSnapshot: fixture.steering.snapshot(),
      includeAcknowledgement: false, includeTitle: false, allowPlanner: true, allowAuditor: true,
      observationGuidance: [],
    });
    expect(after.messages[0]).toEqual(before.messages[0]);
    expect(after.format).toEqual(before.format);
    expect(after.messages.findIndex(({ content }) => content === fixture.request.prompt)).toBeLessThan(
      after.messages.indexOf(after.promptCacheBoundaryBeforeMessage!),
    );
    const dynamicSystem = after.messages.slice(1).filter(({ role }) => role === "system");
    expect(dynamicSystem.length).toBeGreaterThan(0);
    expect(dynamicSystem.some(({ content }) => content.includes("Use the latest supplied continuation checkpoint"))).toBe(true);
  });
});
