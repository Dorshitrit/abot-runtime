import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { resolveModelSelection } from "../model/model-selection.js";
import { projectRequestModelSelection } from "../request/model-selection-presentation.js";
import { handleRunRequest } from "../request/handler.js";
import { runRequestRunner } from "../request/runner.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

vi.mock("../request/runner.js", () => ({ runRequestRunner: vi.fn() }));
const root = { decisionModelStep: "execution.decision", responseModelStep: "execution.response" } as const;
const policy: ModelGatewayPolicyConfig = {
  providers: { native: { type: "llamacpp", baseUrl: "http://private-provider", apiKeyEnv: "SECRET_KEY" } },
  profiles: {
    local: { provider: "native", label: "Local model", model: "local-model", contextWindowTokens: 32000, supportsThinking: true },
    configured: { provider: "native", model: "configured-model", contextWindowTokens: 32000 },
  },
  invocationProfiles: { alias: { profileId: "local" } },
  defaults: { profileId: "configured" },
};

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.mocked(runRequestRunner).mockReset();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

describe("request model selection presentation", () => {
  test.each([
    [undefined, false, "configured"], ["local", false, "local"], ["alias", false, "local"], ["local", true, "configured"],
  ] as const)("projects canonical selection for %s with override %s", (profileId, override, expected) => {
    const modelPolicy = { ...policy, defaults: { ...policy.defaults, overrideClientPreference: override } };
    const selection = resolveModelSelection({ agentMode: "deep", modelPreference: profileId ? { profileId } : undefined, modelPolicy });
    const result = projectRequestModelSelection({ ...selection, executionPolicySelection: selection.execution }, root, 10);
    expect(result).toMatchObject({ primaryProfileId: expected, agentMode: "deep", selectedAt: 10, rootModelSteps: ["execution.decision", "execution.response"] });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_KEY|private-provider|apiKeyEnv|baseUrl/);
  });

  test("copies restored controls and identity without reading a changed configuration", () => {
    const selection = resolveModelSelection({ agentMode: "fast", modelPreference: { profileId: "local" }, modelPolicy: policy });
    const restored = { ...selection, executionPolicySelection: selection.execution,
      reasoningPreference: { profileId: "local", mode: "budget" as const, budgetTokens: 64 } };
    const presentation = projectRequestModelSelection(JSON.parse(JSON.stringify(restored)), root, 20);
    restored.reasoningPreference.budgetTokens = 999;
    expect(presentation.reasoningPreference).toEqual({ profileId: "local", mode: "budget", budgetTokens: 64 });
    expect(presentation.primaryModel).toEqual({ label: "Local model", provider: "llamacpp", model: "local-model" });
  });

  test("handler publishes and persists the same chosen model before execution for later snapshot/replay", async () => {
    const runtimeConfig = await createRuntimeConfig();
    await writeFile(runtimeConfig.requestRunner.configPath!, JSON.stringify({ schemaVersion: 2,
      models: { defaults: { profileId: "configured", steps: {} } }, context: {
        outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
      stepDefaults: { timeoutMs: 1000 }, steps: {} }));
    runtimeConfig.models = policy;
    const sessionStore = createInMemorySessionStore();
    const frames: Record<string, unknown>[] = [];
    const ws = { send: (text: string) => frames.push(JSON.parse(text)) } as unknown as WebSocket;
    vi.mocked(runRequestRunner).mockImplementation(async () => {
      expect(frames).toContainEqual(expect.objectContaining({ name: "request.model.selected", primaryProfileId: "local", agentMode: "deep" }));
      return { output: "Done." };
    });
    const invoke = vi.fn(async () => { throw new Error("Unexpected live model invocation"); });
    await handleRunRequest(ws, { type: "run_request", requestId: "request", sessionId: "session", text: "Hello",
      agentMode: "deep", modelPreference: { profileId: "local" },
      reasoningPreference: { profileId: "local", mode: "budget", budgetTokens: 64 } },
    { runtimeConfig, sessionStore, modelGatewayClient: { invoke, invokeRaw: invoke } });
    expect(runRequestRunner).toHaveBeenCalledOnce();
    const replay = await sessionStore.getRequestReplayById("request");
    expect(replay?.events).toContainEqual(expect.objectContaining({ name: "request.model.selected", primaryProfileId: "local" }));
    const snapshot = await sessionStore.getSessionSnapshot("session");
    expect(snapshot?.modelSelection).toMatchObject({ requestId: "request", primaryProfileId: "local", agentMode: "deep", status: "completed",
      reasoningPreference: { profileId: "local", mode: "budget", budgetTokens: 64 } });
    await handleRunRequest(ws, { type: "run_request", requestId: "next-request", sessionId: "session", text: "Continue",
      agentMode: "fast", modelPreference: { profileId: "configured" } },
    { runtimeConfig, sessionStore, modelGatewayClient: { invoke, invokeRaw: invoke } });
    expect(frames.filter((frame) => frame.name === "request.model.selected").map((frame) => frame.primaryProfileId))
      .toEqual(["local", "configured"]);
    expect((await sessionStore.getSessionSnapshot("session"))?.modelSelection)
      .toMatchObject({ requestId: "next-request", primaryProfileId: "configured", agentMode: "fast" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
