import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { invokeModelStep, RequestModelStepInvoker } from "../model/invoke-step.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { snapshotRequestSeed, type PersistedRequestSeed } from "../request/approval-wait/snapshot.js";
import { createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("model counting and generation keep session cache scope through new requests and saved-seed reconstruction", async () => {
  const fixture = await createControlsEvidenceFixture();
  const saved = JSON.parse(JSON.stringify(snapshotRequestSeed(fixture.request))) as PersistedRequestSeed;
  const requests = [
    fixture.request,
    deriveTestRequestExecutionScope(fixture.request, { requestId: "next-request", requestSteering: undefined }),
    deriveTestRequestExecutionScope(fixture.request, { ...saved, modelInvocationScope: "resumed-activation" }),
    deriveTestRequestExecutionScope(fixture.request, { sessionId: "other-session" }),
  ];
  const messages: ChatMessage[] = [{ role: "system", content: "Fixed instructions" }, { role: "user", content: "Hello" }];
  const before = JSON.stringify(messages);
  for (const request of requests) {
    await invokeModelStep({ request, modelStep: "execution.response", messages,
      timeoutReason: "fixture_timeout", accept: (text) => text });
  }
  const expected = [saved.sessionId, saved.sessionId, saved.sessionId, "other-session"];
  expect(fixture.invoke.mock.calls.map(([input]) => input.promptCacheScope)).toEqual(expected);
  expect(fixture.countInputTokens.mock.calls.map(([input]) => input.promptCacheScope)).toEqual(expected);
  expect(fixture.invoke.mock.calls.map(([input]) => input.debugRequestId)).toEqual([
    saved.requestId, "next-request", saved.requestId, saved.requestId,
  ]);
  expect(JSON.stringify(messages)).toBe(before);
  expect(saved).not.toHaveProperty("promptCacheScope");
  expect(saved).not.toHaveProperty("prompt_cache_key");
});

test("utility calls without a conversation do not invent a cache scope", async () => {
  const fixture = await createControlsEvidenceFixture();
  const { sessionId: _sessionId, ...utility } = fixture.request.modelInvocation;
  await new RequestModelStepInvoker(utility).invoke({
    modelStep: "execution.response", messages: [{ role: "user", content: "Utility input" }],
    timeoutReason: "fixture_timeout", accept: (text) => text,
  });
  expect(fixture.invoke.mock.calls[0]![0]).not.toHaveProperty("promptCacheScope");
  expect(fixture.countInputTokens.mock.calls[0]![0]).not.toHaveProperty("promptCacheScope");
});
