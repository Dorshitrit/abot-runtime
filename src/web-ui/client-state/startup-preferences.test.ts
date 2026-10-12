import { afterEach, expect, test, vi } from "vitest";
import { emptyClientState } from "./contracts.js";
import { updatePreference } from "./preferences.js";
import { createClientPreferences } from "../app/services/client-preferences.js";
import { createRuntimeSelectionController } from "../app/controllers/runtime-selection-controller.js";
// @ts-expect-error Internal browser startup.
import { bootstrapWebApp } from "../app/app-bootstrap.js";
// @ts-expect-error Internal browser transport.
import { createWorkspaceStateStorage } from "../app/services/workspace-state-storage.js";

vi.mock("../app/spark-chat-feature.js", () => ({ createSparkChatFeature: () => ({ bind() {}, environmentChanged() {} }) }));
vi.mock("../app/automations-feature.js", () => ({ createAutomationsFeature: () => ({ refreshAvailability() {} }) }));
vi.mock("../app/controllers/spark-handoff-navigation.js", () => ({ createSparkHandoffNavigation: () => ({}) }));
afterEach(() => vi.unstubAllGlobals());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test.each(["environment acknowledgement", "refresh"])("startup retains another window's preference fields arriving through %s", async (arrival) => {
  vi.stubGlobal("window", { location: { href: "http://localhost/home" } });
  const serverState = emptyClientState();
  serverState.preferences["abot-web.environmentId"] = arrival === "refresh" ? "prod" : "dev";
  const storage = createWorkspaceStateStorage({ fetchImpl: async (_path: string, input?: RequestInit) => {
    if (input?.method === "POST") {
      const mutation = JSON.parse(String(input.body));
      updatePreference(serverState.preferences, mutation);
      serverState.revision += 1;
    }
    return Response.json({ state: serverState });
  } });
  await storage.refresh();
  const preferences = createClientPreferences(storage);
  const state: Record<string, unknown> = { currentSessionId: "local-chat", modelProfiles: [] };
  const dom = { environmentSelect: { value: "prod" }, modelSelect: { value: "", options: [] },
    agentModeButton: { setAttribute: vi.fn(), classList: { toggle: vi.fn() } },
    agentModeMenu: { setAttribute: vi.fn(), classList: { toggle: vi.fn() } },
  };
  const runtimeSelection = createRuntimeSelectionController({ state, dom, preferences, modelSelector: { sync: vi.fn() }, client: {} } as never);
  const config = deferred();
  const models = deferred();
  const loadModels = vi.fn(() => models.promise);
  const dashboard = { setActive: vi.fn(), setReady: vi.fn(), refresh: vi.fn() };
  const startup = bootstrapWebApp({ state, dom, preferences,
    selection: { ...runtimeSelection, renderPermissionMode: vi.fn(), renderEnvironmentOptions: vi.fn(), renderAgentPicker: vi.fn(),
      environmentOptions: () => [{ value: "prod" }], loadModels, loadAgentMode: vi.fn() },
    shell: { load: vi.fn(), activeWorkspace: () => "home", bind: vi.fn() },
    homeComposer: { setWorkspace: vi.fn(), environmentChanged: vi.fn() }, dashboard,
    schedules: { refreshAvailability: vi.fn() },
    client: { loadWebConfig: async () => { await config.promise; return { defaultEnvironmentId: "prod" }; } },
    bindables: [], bindEvents: vi.fn(), renderComposer: vi.fn(), renderMessages: vi.fn(),
    operations: { loadRuntimeStatus: vi.fn(), loadSystemHealth: vi.fn() },
    configuration: { load: vi.fn() }, realtime: { connect: vi.fn() }, restoreLastSession: vi.fn(),
  });
  expect(state.sessionModels).toEqual({});
  // A second window commits independent selections after initial preference hydration.
  serverState.preferences["abot-web.sessionModels"] = JSON.stringify({ remote: "remote-model" });
  serverState.preferences["abot-web.lastModelByEnvironment"] = JSON.stringify({ remote: "remote-model" });
  serverState.preferences["abot-web.sessionModes"] = JSON.stringify({ remote: { toolPermissionMode: "ask", savedAt: 1 } });
  serverState.revision += 1;
  config.resolve();
  await vi.waitFor(() => expect(loadModels).toHaveBeenCalledOnce());
  await storage.flush();
  if (arrival === "refresh") await storage.refresh();
  expect(state.sessionModels).toEqual({ remote: "remote-model" });
  expect(dashboard.refresh).not.toHaveBeenCalled();
  models.resolve();
  await startup;
  const sessionModels = state.sessionModels as Record<string, string>;
  sessionModels.local = "local-model";
  await preferences.saveModelPreferences(sessionModels, state.lastModelByEnvironment as Record<string, string>);
  const modes = state.sessionModes as Record<string, { toolPermissionMode: string; savedAt: number }>;
  modes.local = { toolPermissionMode: "full_access", savedAt: 2 };
  await preferences.saveSessionModes(modes);
  expect(JSON.parse(serverState.preferences["abot-web.sessionModels"])).toEqual({ remote: "remote-model", local: "local-model" });
  expect(JSON.parse(serverState.preferences["abot-web.sessionModes"])).toEqual({
    remote: { toolPermissionMode: "ask", savedAt: 1 }, local: { toolPermissionMode: "full_access", savedAt: 2 },
  });
  expect(storage.error()).toBeNull();
});
