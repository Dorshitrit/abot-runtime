import { afterEach, expect, test, vi } from "vitest";
import { installSparkDocument, sparkDom } from "./support/spark-composer-dom.js";
import { createSparkQueueFixture } from "./support/spark-composer-queue.js";
import { createConversationReasoningPreferences } from "../../web-ui/app/services/conversation-reasoning-preferences.js";
// @ts-expect-error Browser composition.
import { createSparkChatConversation } from "../../web-ui/app/spark-chat-conversation.js";

const capture = vi.hoisted(() => ({ storage: undefined as any }));
vi.mock("../../web-ui/app/services/workspace-state.js", () => ({
  workspaceStorage: () => capture.storage,
  workspaceQueue: () => undefined,
}));
vi.mock("../../web-ui/app/controllers/conversation-view-feature.js", () => ({
  createConversationViewFeature: () => new Proxy({}, { get: () => vi.fn() }),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function harness() {
  installSparkDocument();
  const values = new Map<string, string>();
  capture.storage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
  const preferences = createConversationReasoningPreferences(capture.storage);
  const configuration = { modelProfileId: "gemma", sessionId: "spark", supportsThinking: true, reasoningControls: { budgetTokens: true } };
  let environment = "prod";
  const conversation = createSparkChatConversation({
    dom: sparkDom(), client: {}, shell: { showToast: vi.fn() },
    getEnvironmentId: () => environment, getConfiguration: () => configuration,
    isOpen: () => false, isConnected: () => false, getSubmissionBlock: () => null,
    scrollBehavior: {}, refresh: vi.fn(), onReadState: vi.fn(), sendRealtime: vi.fn(),
    sessionQueue: createSparkQueueFixture().queue,
  });
  preferences.saveReasoningPreference({ environmentId: "prod", sessionId: "spark" }, "gemma", { profileId: "gemma", mode: "off" });
  return { conversation, preferences, configuration, storage: capture.storage,
    setEnvironment: (next: string) => { environment = next; } };
}

test("SPARK clears only its own captured override before applying a shared mode", async () => {
  const h = harness();
  h.preferences.saveReasoningPreference({ environmentId: "prod", sessionId: "ordinary" }, "gemma", { profileId: "gemma", mode: "off" });
  await h.conversation.setAgentMode("deep");
  expect(h.conversation.state.agentMode).toBe("deep");
  expect(h.conversation.getReasoningPreference()).toBeUndefined();
  expect(h.preferences.loadReasoningPreference({ environmentId: "prod", sessionId: "ordinary" }, "gemma")).toEqual({ profileId: "gemma", mode: "off" });
});

test("a failed SPARK clear keeps both the saved mode and its effective manual override", async () => {
  const h = harness();
  h.conversation.state.agentMode = "fast";
  h.storage.setItem.mockImplementationOnce(async () => { throw new Error("workspace offline"); });
  await expect(h.conversation.setAgentMode("deep")).rejects.toThrow("workspace offline");
  expect(h.conversation.state.agentMode).toBe("fast");
  expect(h.conversation.getReasoningPreference()).toEqual({ profileId: "gemma", mode: "off" });
});

test("a delayed SPARK clear cannot apply its mode to a new environment, session or model", async () => {
  const h = harness();
  let finish!: () => void;
  h.storage.setItem.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const pending = h.conversation.setAgentMode("deep");
  h.setEnvironment("dev");
  h.configuration.sessionId = "other";
  h.configuration.modelProfileId = "other";
  h.conversation.state.agentMode = "fast";
  finish();
  await pending;
  expect(h.conversation.state.agentMode).toBe("fast");
});

test.each(["budget", "server-default"])("SPARK retains independent %s settings when its effort changes", async (mode) => {
  const h = harness();
  const preference = mode === "budget"
    ? { profileId: "gemma", mode: "budget" as const, budgetTokens: 128 }
    : { profileId: "gemma", mode: "server-default" as const };
  h.preferences.saveReasoningPreference({ environmentId: "prod", sessionId: "spark" }, "gemma", preference);
  await h.conversation.setAgentMode("deep");
  expect(h.conversation.state.agentMode).toBe("deep");
  expect(h.conversation.getReasoningPreference()).toEqual(preference);
});
