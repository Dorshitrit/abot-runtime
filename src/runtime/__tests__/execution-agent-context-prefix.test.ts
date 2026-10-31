import { executionPrefixCachePolicy } from "./support/execution-prefix-cache-fixture.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { buildExecutionAgentResponseInput } from "../steps/execution-agent/response-input.js";
import { buildExecutionContinuationMessages } from "../steps/execution-agent/state-context.js";
import { appendRequestSteeringContext } from "../request/request-steering-context.js";
import { activeEvidenceCall, createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";

type Fixture = Awaited<ReturnType<typeof createControlsEvidenceFixture>>;
function buildInput(fixture: Fixture, request = fixture.request) {
  const head = fixture.ledger.current();
  return buildExecutionAgentInput(request, {
    head, call: activeEvidenceCall(head), steeringSnapshot: fixture.steering.snapshot(),
    includeAcknowledgement: false, includeTitle: false, allowPlanner: true, allowAuditor: true,
  });
}
function withProvider(request: RequestExecutionScope, type: string): RequestExecutionScope {
  return { ...request, modelPolicy: {
    ...request.modelPolicy, providers: { openai: { type } },
  } };
}
function capsuleIndex(messages: readonly ChatMessage[], kind: string): number {
  return messages.findIndex(({ content }) => {
    try { return JSON.parse(content).kind === kind; } catch { return false; }
  });
}
function nativeMessages(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  return messages.filter((message) => message.role === "tool" ||
    (message.role === "assistant" && message.toolCalls !== undefined));
}
const serializedMessages = (messages: readonly ChatMessage[]) => messages.map((message) => JSON.stringify(message)).sort();

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("OpenAI API EA decision stable context prefix", () => {
  test("retains exact evidence before changing activation state without changing admission or message authority", async () => {
    const fixture = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
    await fixture.addResult('FIRST exact \"quoted\" body שלום');
    const legacy = buildInput(fixture, withProvider(fixture.request, "ollama"));
    const current = buildInput(fixture);
    expect(current.context.budget).toEqual(legacy.context.budget);
    expect(current.context.selectedHistoryMessageIds).toEqual(legacy.context.selectedHistoryMessageIds);
    expect(current.context.omittedHistoryMessageIds).toEqual(legacy.context.omittedHistoryMessageIds);
    expect(serializedMessages(current.messages)).toEqual(serializedMessages(legacy.messages));
    expect(current.context.messages).toEqual(current.messages);
    validateModelGatewayMessages(current.messages);
    const promptIndex = current.messages.findIndex(({ content }) => content === fixture.request.prompt);
    expect(current.messages.filter(({ content }) => content === fixture.request.prompt)).toHaveLength(1);
    const stateIndex = capsuleIndex(current.messages, "runtime_execution_state_v1");
    const catalogIndex = capsuleIndex(current.messages, "runtime_execution_capability_catalog_v1");
    const toolIndex = current.messages.findIndex(({ role }) => role === "tool");
    expect(catalogIndex).toBeLessThan(promptIndex);
    expect(promptIndex).toBeLessThan(toolIndex);
    expect(toolIndex).toBeLessThan(stateIndex);
    const boundaryIndex = current.messages.indexOf(current.promptCacheBoundaryBeforeMessage!);
    expect(boundaryIndex).toBeGreaterThan(toolIndex);
    expect(boundaryIndex).toBeLessThanOrEqual(stateIndex);
    expect(nativeMessages(current.messages)).toEqual(nativeMessages(legacy.messages));
    const head = fixture.ledger.current();
    expect(nativeMessages(current.messages)).toEqual(buildExecutionContinuationMessages(head, activeEvidenceCall(head)));
  });

  test("keeps the settled prefix when another exact tool result advances the activation", async () => {
    const fixture = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
    await fixture.addResult("FIRST body");
    const before = buildInput(fixture);
    await fixture.addResult("SECOND body", { failed: true });
    const after = buildInput(fixture);
    const beforeLastResult = before.messages.map(({ role }) => role).lastIndexOf("tool");
    expect(after.messages.slice(0, beforeLastResult + 1)).toEqual(before.messages.slice(0, beforeLastResult + 1));
    expect(nativeMessages(after.messages).slice(0, nativeMessages(before.messages).length)).toEqual(nativeMessages(before.messages));
    expect(capsuleIndex(after.messages, "runtime_execution_state_v1")).toBeGreaterThan(
      after.messages.map(({ role }) => role).lastIndexOf("tool"),
    );
    validateModelGatewayMessages(after.messages);
  });

  test("keeps steering last and the projected context consistent with dispatched messages", async () => {
    const fixture = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
    await fixture.addResult("FIRST body");
    fixture.steering.append({ steerId: "steer-one", text: "Report only the observed value." });
    const input = buildInput(fixture);
    expect(input.messages).toEqual(appendRequestSteeringContext(input.context.messages, fixture.steering.snapshot()));
    expect(input.messages.at(-1)?.content).toContain("Report only the observed value.");
    expect(capsuleIndex(input.messages, "runtime_execution_state_v1")).toBeLessThan(input.messages.length - 1);
    expect(input.messages.filter(({ content }) => content === fixture.request.prompt)).toHaveLength(1);
  });

  test.each(["ollama", "llamacpp", "openai-chatgpt"])("preserves existing %s decision topology and evidence", async (provider) => {
    const fixture = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
    await fixture.addResult("UNCHANGED body");
    const baseline = buildInput(fixture, withProvider(fixture.request, "ollama"));
    const input = buildInput(fixture, withProvider(fixture.request, provider));
    expect(input.promptCacheBoundaryBeforeMessage).toBeUndefined();
    expect(input.context).toEqual(baseline.context);
    expect(input.messages).toEqual(baseline.messages);
    const stateIndex = capsuleIndex(input.messages, "runtime_execution_state_v1");
    expect(stateIndex).toBeLessThan(input.messages.findIndex(({ content }) => content === fixture.request.prompt));
  });

  test("undeclared OpenAI profiles keep their original order and omit the cache boundary", async () => {
    const fixture = await createControlsEvidenceFixture();
    await fixture.addResult("UNCHANGED body");
    const input = buildInput(fixture);
    const legacy = buildInput(fixture, withProvider(fixture.request, "ollama"));
    expect(input.messages).toEqual(legacy.messages);
    expect(input.promptCacheBoundaryBeforeMessage).toBeUndefined();
  });

  test("leaves response authoring topology unchanged for OpenAI", async () => {
    const fixture = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
    await fixture.addResult("RESPONSE evidence");
    const head = fixture.ledger.current();
    const options = { head, call: activeEvidenceCall(head), steeringSnapshot: fixture.steering.snapshot() };
    const remote = buildExecutionAgentResponseInput(fixture.request, options);
    const local = buildExecutionAgentResponseInput(withProvider(fixture.request, "ollama"), options);
    expect(remote.context).toEqual(local.context);
    expect(remote.messages).toEqual(local.messages);
  });
});
