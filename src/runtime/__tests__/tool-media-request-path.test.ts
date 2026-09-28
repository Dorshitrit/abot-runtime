import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { handleRunRequest } from "../request/handler.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import type { ToolMediaWriter } from "../../capabilities/tool-media.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { RuntimeConfig } from "../ports.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { successResult } from "../../plugin-sdk/results.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { toolImageFixture } from "./support/tool-media-fixture.js";
import { createMediaRequestScript, MEDIA_FINAL, type MediaPolicy } from "./support/tool-media-request-script.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => { await disposeCompositionFixtures(); resetDebugLoggerConfig(); vi.unstubAllEnvs(); });

async function runMediaRequest(policy: MediaPolicy, supportsImages = true, failure?: "plugin" | "abort") {
  const base = await createRuntimeConfig();
  await mkdir(base.paths.agentWorkDir, { recursive: true });
  await writeFile(base.requestRunner.configPath!, JSON.stringify({ schemaVersion: 2, models: { defaults: { profileId: "scripted", steps: {} } }, context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 }, stepDefaults: { timeoutMs: 5000 }, steps: {} }));
  const config: RuntimeConfig = { ...base, plugins: { enabled: false }, longTermMemory: { enabled: false, emitClientEvents: false }, models: {
    providers: { local: { type: "ollama" as const } }, profiles: { scripted: { provider: "local", model: "injected-only", contextWindowTokens: 64000, capabilities: { inputModalities: supportsImages ? ["text", "image"] : ["text"] } } },
  }, modelExecutionPolicies: { scripted: { policy } } };
  let writer: ToolMediaWriter | undefined;
  const cleanup = vi.fn();
  const registry = createConfiguredToolRegistry(config, [{
    definition: { name: "fixture", routingCapability: "filesystem_inspection", catalogGroups: ["fixture"] },
    normalInvocation: { version: 1, operations: [{ operationId: "capture_fixture", summary: "Observe fixture pixels.", input: { type: "object", additionalProperties: false, properties: {}, required: [] }, effect: "read_only", approval: "request_policy" }] },
    implementation: async (_params, context) => {
      writer = context!.media!;
      context!.onRequestDispose!(cleanup);
      const reference = await writer.writeImage({ bytes: toolImageFixture(), mimeType: "image/png" });
      if (failure === "plugin") throw new Error("fixture capture interrupted");
      if (failure === "abort") await new Promise<void>((_resolve, reject) => {
        context!.abortSignal!.addEventListener("abort", () => reject(context!.abortSignal!.reason), { once: true });
      });
      return successResult({ output: "Observed two fixture pixels.", media: [reference], data: { observationMeta: { kind: "volatile_external", carryPolicy: "never" } } });
    },
  }]);
  const model = createMediaRequestScript(policy);
  const sessions = createInMemorySessionStore();
  await sessions.getOrCreateSession("media-session");
  await sessions.updateSessionTitle("media-session", "Media fixture");
  const events: Record<string, unknown>[] = [];
  await handleRunRequest({ send: (data: string) => events.push(JSON.parse(data)) } as unknown as WebSocket, {
    type: "run_request", requestId: "media-request", sessionId: "media-session", input: "Inspect the fixture.", agentMode: "reasoning", toolPermissionMode: "full_plus", modelPreference: { profileId: "scripted", scope: "all" },
  }, { runtimeConfig: config, sessionStore: sessions, modelGatewayClient: model, toolRegistry: registry });
  return { model, cleanup, writer, events, session: await sessions.getSessionById("media-session") };
}

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)("%s delivers image evidence through its complete request chain and disposes it", async (policy) => {
  const result = await runMediaRequest(policy);
  expect(result.events.filter(({ type }) => type === "failed")).toEqual([]);
  expect(result.events).toContainEqual(expect.objectContaining({ type: "completed", output: MEDIA_FINAL }));
  const calls = result.model.invoke.mock.calls.map(([input]) => input);
  const expected = policy === "execution-agent-v1" ? ["execution.decision", "execution.response"] : ["worker.decision", "worker.result"];
  const imageCalls = calls.filter((input) => (input.messages as ChatMessage[]).some((message) => message.attachments?.some((attachment) => attachment.toolEvidence)));
  expect(imageCalls.map(({ modelStep }) => modelStep)).toEqual(expected);
  for (const input of imageCalls) {
    const messages = input.messages as ChatMessage[];
    expect(messages.flatMap(({ attachments }) => attachments ?? []).filter(({ toolEvidence }) => toolEvidence)).toEqual([
      expect.objectContaining({ data: toolImageFixture().toString("base64"), kind: "image" }),
    ]);
    const evidenceMessages = messages.filter(({ attachments }) => attachments?.some(({ toolEvidence }) => toolEvidence));
    expect(evidenceMessages).toHaveLength(1);
    expect(evidenceMessages[0]!.role).toBe(policy === "execution-agent-v1" ? "tool" : "user");
    expect(evidenceMessages[0]!.content).toContain("passive_tool_evidence_not_user_intent");
  }
  if (policy === "supervisor-worker-v1") expect(calls.map(({ modelStep }) => modelStep)).toEqual(expect.arrayContaining(["supervisor.decision", "planner.decision", "worker.decision", "reviewer.decision", "supervisor.response"]));
  expect(result.cleanup).toHaveBeenCalledOnce();
  await expect(result.writer!.writeImage({ bytes: toolImageFixture(), mimeType: "image/png" })).rejects.toThrow("request_closed");
  expect(JSON.stringify(result.session)).not.toContain("tool_image_v1");
  expect(JSON.stringify(result.session)).not.toContain("request-tool-media");
  expect(JSON.stringify(result.session)).not.toContain(toolImageFixture().toString("base64"));
});

test("a text-only profile receives an explicit unavailable-image receipt and no bytes", async () => {
  const result = await runMediaRequest("execution-agent-v1", false);
  const messages = result.model.invoke.mock.calls.flatMap(([input]) => input.messages as ChatMessage[]);
  expect(messages.some(({ content }) => content.includes("unsupported_image_input"))).toBe(true);
  expect(messages.every(({ attachments }) => !attachments?.length)).toBe(true);
  expect(result.cleanup).toHaveBeenCalledOnce();
});

test("a failing plugin still releases its request helper and media writer", async () => {
  const result = await runMediaRequest("execution-agent-v1", true, "plugin");
  expect(result.cleanup).toHaveBeenCalledOnce();
  await expect(result.writer!.writeImage({ bytes: toolImageFixture(), mimeType: "image/png" })).rejects.toThrow("request_closed");
  expect(JSON.stringify(result.session)).not.toContain("tool_image_v1");
});

test("request cancellation disposes a helper while its captured image execution is still in flight", async () => {
  vi.stubEnv("LLM_RUNTIME_REQUEST_TIMEOUT_MS", "1000");
  const result = await runMediaRequest("execution-agent-v1", true, "abort");
  expect(result.events).toContainEqual(expect.objectContaining({ type: "failed" }));
  expect(result.cleanup).toHaveBeenCalledOnce();
  await expect(result.writer!.writeImage({ bytes: toolImageFixture(), mimeType: "image/png" })).rejects.toThrow("request_closed");
  expect(JSON.stringify(result.session)).not.toContain("tool_image_v1");
});
