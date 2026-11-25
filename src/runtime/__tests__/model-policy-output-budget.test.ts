import { afterEach, beforeEach, expect, test } from "vitest";
import { createRequestModelPolicy } from "../config/runner/model-policy.js";
import { invokeModelStep } from "../model/invoke-step.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { snapshotRequestSeed, type PersistedRequestSeed } from "../request/approval-wait/snapshot.js";
import { createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("runner safety headroom overrides platform metadata without changing model parameters", async () => {
  const fixture = await createControlsEvidenceFixture();
  const platformPolicy = { ...fixture.request.modelPolicy, outputSafetyReserveTokens: 9999 };
  const before = JSON.stringify(platformPolicy);
  const policy = createRequestModelPolicy({ platformPolicy, runnerConfig: fixture.request.runnerConfig });
  expect(policy.outputSafetyReserveTokens).toBe(200);
  expect(policy.profiles).toEqual(platformPolicy.profiles);
  expect(JSON.stringify(platformPolicy)).toBe(before);
  const updated = createRequestModelPolicy({ platformPolicy, runnerConfig: {
    ...fixture.request.runnerConfig,
    context: { ...fixture.request.runnerConfig.context, safetyReserveTokens: 400 },
  } });
  expect(updated.outputSafetyReserveTokens).toBe(400);
  expect(policy.outputSafetyReserveTokens).toBe(200);
});

test("saved approval reconstruction preserves output headroom for input counting and generation", async () => {
  const fixture = await createControlsEvidenceFixture();
  const policy = createRequestModelPolicy({
    platformPolicy: fixture.request.modelPolicy, runnerConfig: fixture.request.runnerConfig,
  });
  const original = deriveTestRequestExecutionScope(fixture.request, { modelPolicy: policy });
  const saved = JSON.parse(JSON.stringify(snapshotRequestSeed(original))) as PersistedRequestSeed;
  policy.outputSafetyReserveTokens = 9999;
  const resumed = deriveTestRequestExecutionScope(fixture.request, {
    ...saved, modelInvocationScope: "resumed-output-budget",
  });
  expect(resumed.modelPolicy?.outputSafetyReserveTokens).toBe(200);
  await invokeModelStep({ request: resumed, modelStep: "execution.response",
    messages: [{ role: "user", content: "Continue the saved task." }],
    timeoutReason: "fixture_timeout", accept: (text) => text });
  expect(fixture.countInputTokens.mock.calls[0]![0].modelPolicy?.outputSafetyReserveTokens).toBe(200);
  expect(fixture.invoke.mock.calls[0]![0].modelPolicy?.outputSafetyReserveTokens).toBe(200);
});

test("legacy saved requests keep absent output headroom absent", async () => {
  const fixture = await createControlsEvidenceFixture();
  const saved = JSON.parse(JSON.stringify(snapshotRequestSeed(fixture.request))) as PersistedRequestSeed;
  const restored = deriveTestRequestExecutionScope(fixture.request, saved);
  expect(restored.modelPolicy).not.toHaveProperty("outputSafetyReserveTokens");
});
