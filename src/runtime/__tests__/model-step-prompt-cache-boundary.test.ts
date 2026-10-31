import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { invokeModelStep } from "../model/invoke-step.js";
import { invokeStructuredModelStep } from "../model/invoke-structured-step.js";
import { projectPromptCacheBoundary } from "../model/prompt-cache-boundary.js";
import { RequestToolResources } from "../capabilities/request-tool-resources.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { executionPrefixCachePolicy } from "./support/execution-prefix-cache-fixture.js";
import { toolImageFixture, toolImageMessages } from "./support/tool-media-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const stable: ChatMessage = { role: "user", content: "settled reference" };
const activation: ChatMessage = { role: "user", content: "current activation" };

test("the boundary follows only its unique exact reference in each admitted candidate", () => {
  expect(projectPromptCacheBoundary({ messages: [stable, activation], beforeMessage: activation }))
    .toEqual({ promptCacheBoundaryBeforeMessageIndex: 1 });
  for (const messages of [[], [stable], [activation, stable], [stable, { ...activation }], [stable, activation, activation]])
    expect(projectPromptCacheBoundary({ messages, beforeMessage: activation })).toEqual({});
  expect(projectPromptCacheBoundary({ messages: [stable, activation] })).toEqual({});
  expect(projectPromptCacheBoundary({ messages: [stable, stable, activation], beforeMessage: activation }))
    .toEqual({ promptCacheBoundaryBeforeMessageIndex: 2 });
});

test("optional omission and tool-media hydration produce the same live boundary for count and inference", async () => {
  const resources = new RequestToolResources();
  const execution = resources.media.beginExecution({ callId: "call-1", executionId: "execution-1" }, new AbortController().signal);
  const reference = await execution.writer.writeImage({ bytes: toolImageFixture(), mimeType: "image/png" });
  execution.finish([reference]);
  const policy = { ...executionPrefixCachePolicy, profiles: { test: {
    ...executionPrefixCachePolicy.profiles!.test!, capabilities: { inputModalities: ["text", "image"] as ("text" | "image")[] },
  } } };
  const f = await createControlsEvidenceFixture({ modelPolicy: policy, toolResources: resources });
  const optional: ChatMessage = { role: "user", content: "optional reference" };
  const messages: ChatMessage[] = [optional, ...toolImageMessages(reference), activation];
  f.countInputTokens.mockImplementation(async (input) => ({
    inputTokens: (input.messages as ChatMessage[]).includes(optional) ? 40_000 : 1000,
    profileId: "test", provider: "openai", model: "test", contextWindowTokens: 32000,
    source: "provider_input_token_count",
  }));
  try {
    await invokeModelStep({ request: f.request, modelStep: "execution.decision", messages,
      promptCacheBoundaryBeforeMessage: activation, contextRetention: "exact",
      optionalContextProjection: (candidate) => candidate.filter((message) => message !== optional),
      timeoutReason: "fixture_timeout", accept: () => "accepted",
    });
    const counted = f.countInputTokens.mock.calls.map(([input]) => input);
    expect(counted.map((input) => input.promptCacheBoundaryBeforeMessageIndex)).toEqual([4, 3]);
    const dispatched = f.invoke.mock.calls[0]![0];
    expect(dispatched.promptCacheBoundaryBeforeMessageIndex).toBe(3);
    expect(dispatched.messages).toEqual(counted.at(-1)!.messages);
    const delivered = dispatched.messages as ChatMessage[];
    expect(delivered[2]?.attachments?.[0]?.data).toBe(toolImageFixture().toString("base64"));
    expect(delivered[3]).toBe(activation);
    expect(messages[3]?.attachments).toBeUndefined();
  } finally { await resources.dispose(); }
});

test("an optional projection that removes the anchor never resurrects or rebinds it", async () => {
  const f = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
  f.countInputTokens.mockImplementation(async (input) => ({
    inputTokens: (input.messages as ChatMessage[]).includes(activation) ? 40_000 : 1000,
    profileId: "test", provider: "openai", model: "test", contextWindowTokens: 32000,
    source: "provider_input_token_count",
  }));
  await invokeModelStep({ request: f.request, modelStep: "execution.decision", messages: [stable, activation],
    promptCacheBoundaryBeforeMessage: activation, contextRetention: "exact",
    optionalContextProjection: (messages) => messages.filter((message) => message !== activation),
    timeoutReason: "fixture_timeout", accept: () => "accepted",
  });
  expect(f.countInputTokens.mock.calls.map(([input]) => input.promptCacheBoundaryBeforeMessageIndex)).toEqual([1, undefined]);
  const dispatched = f.invoke.mock.calls[0]![0];
  expect(dispatched.messages).toEqual([stable]);
  expect(dispatched).not.toHaveProperty("promptCacheBoundaryBeforeMessageIndex");
});

test("structured output repairs retain the same anchor before appended repair guidance", async () => {
  const f = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
  let attempts = 0;
  await invokeStructuredModelStep({ request: f.request, modelStep: "execution.decision",
    messages: [stable, activation], promptCacheBoundaryBeforeMessage: activation,
    format: { type: "json_schema", name: "fixture", schema: { type: "object", properties: {}, additionalProperties: false } },
    contextRetention: "exact", timeoutReason: "fixture_timeout", invalidOutputReason: "fixture_invalid",
    parse: () => ++attempts === 1
      ? { ok: false, stage: "fixture", issues: [{ code: "fixture", path: "", message: "Repair structure." }] }
      : { ok: true, decision: "accepted" },
  });
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.invoke.mock.calls.map(([input]) => input.promptCacheBoundaryBeforeMessageIndex)).toEqual([1, 1]);
  const repaired = f.invoke.mock.calls[1]![0].messages as ChatMessage[];
  expect(repaired[1]).toBe(activation);
  expect(repaired.length).toBeGreaterThan(2);
});
