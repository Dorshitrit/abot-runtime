import { describe, expect, test, vi } from "vitest";
import { createToolPermissionModeController } from "../../web-ui/app/controllers/tool-permission-mode-controller.js";
import { normalizeToolPermissionMode } from "../../web-ui/app/lib/tool-permission-mode.js";
import { createClientPreferences } from "../../web-ui/app/services/client-preferences.js";
import { createSessionComposerQueue } from "../../web-ui/app/lib/session-composer-queue.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function control() {
  return {
    innerHTML: "", title: "", disabled: false, hidden: false,
    classList: { toggle: vi.fn() }, setAttribute: vi.fn(), focus: vi.fn(),
    querySelectorAll: () => [],
  };
}

function modeHarness(supported = true, storage = memoryStorage()) {
  let sessionId = "one";
  const preferences = createClientPreferences(storage);
  const state: Parameters<typeof createToolPermissionModeController>[0]["state"] = {
    config: { backend: "runtime", supportedToolPermissionModes:
      supported ? ["ask", "full_access", "full_plus"] : ["ask", "full_access"] },
    sessionModes: preferences.loadSessionModes(normalizeToolPermissionMode), permissionModeMenuOpen: false,
  };
  const recordControlEvent = vi.fn();
  const controller = createToolPermissionModeController({
    state, preferences, recordControlEvent,
    dom: { permissionModeButton: control(), permissionModeMenu: control() },
    getComposerSessionId: () => sessionId,
  });
  return {
    state, preferences, controller, recordControlEvent,
    selectSession: (id: string) => { sessionId = id; },
  };
}

describe("explicit FULL+ client selection", () => {
  test.each([undefined, null, "", "full_access", "Full", "FULL+", "FULL_PLUS", "future_mode"])(
    "keeps legacy FULL as the default for %s without upgrading it", (value) => {
      expect(normalizeToolPermissionMode(value)).toBe("full_access");
    },
  );

  test("preserves ASK aliases and accepts only the explicit FULL+ wire value", () => {
    expect(normalizeToolPermissionMode("ask")).toBe("ask");
    expect(normalizeToolPermissionMode("approval_required")).toBe("ask");
    expect(normalizeToolPermissionMode("full_plus")).toBe("full_plus");
  });

  test("restores explicit per-session FULL+ and ASK without upgrading legacy records", () => {
    const preferences = createClientPreferences(memoryStorage());
    preferences.saveSessionModes({
      plus: { toolPermissionMode: "full_plus", savedAt: 10 },
      ask: { toolPermissionMode: "approval_required", savedAt: 20 },
      full: { toolPermissionMode: "full_access", savedAt: 30 },
      missing: {}, unknown: { toolPermissionMode: "future_mode" },
      displayLabel: { toolPermissionMode: "FULL+" },
    });
    const restored = preferences.loadSessionModes(normalizeToolPermissionMode);
    expect(restored).toEqual({
      plus: { toolPermissionMode: "full_plus", savedAt: 10 },
      ask: { toolPermissionMode: "ask", savedAt: 20 },
      full: { toolPermissionMode: "full_access", savedAt: 30 },
    });
    expect(preferences.loadSessionModes(normalizeToolPermissionMode)).toEqual(restored);
  });

  test.each(["ask", "full_access", "full_plus"] as const)(
    "new sessions inherit explicit %s across browser reloads, while old sessions keep their modes", (mode) => {
      const storage = memoryStorage();
      const first = modeHarness(true, storage);
      first.controller.setToolPermissionMode(mode);
      const restored = modeHarness(true, storage);
      expect(restored.controller.currentToolPermissionMode()).toBe(mode);
      for (const id of ["new-ordinary", "new-project", "new-home", "new-implicit"]) {
        restored.controller.initializeSessionMode(id);
        restored.selectSession(id);
        expect(restored.controller.currentToolPermissionMode()).toBe(mode);
      }
      restored.selectSession("old-session-without-entry");
      expect(restored.controller.currentToolPermissionMode()).toBe("full_access");
      expect(restored.preferences.loadLastToolPermissionMode(normalizeToolPermissionMode)).toBe(mode);
    },
  );

  test("opening or initializing an existing session preserves its mode and the last user choice", () => {
    const harness = modeHarness();
    harness.controller.setToolPermissionMode("ask");
    harness.selectSession("two");
    harness.controller.setToolPermissionMode("full_access");
    harness.selectSession("three");
    harness.controller.setToolPermissionMode("full_plus");
    for (const [id, expected] of [["one", "ask"], ["two", "full_access"], ["three", "full_plus"]]) {
      harness.selectSession(id);
      harness.controller.initializeSessionMode(id);
      expect(harness.controller.currentToolPermissionMode()).toBe(expected);
      expect(harness.preferences.loadLastToolPermissionMode(normalizeToolPermissionMode)).toBe("full_plus");
    }
    harness.controller.clearSessionMode("three");
    harness.controller.initializeSessionMode("new-after-delete");
    harness.selectSession("new-after-delete");
    expect(harness.controller.currentToolPermissionMode()).toBe("full_plus");
  });

  test.each([null, "FULL+", "FULL_PLUS", "future_mode", "{}"])(
    "does not infer FULL+ from a missing or invalid stored default %s", (stored) => {
      const storage = memoryStorage();
      if (stored !== null) storage.setItem("abot-web.lastToolPermissionMode", stored);
      const harness = modeHarness(true, storage);
      harness.controller.initializeSessionMode("new");
      harness.selectSession("new");
      expect(harness.controller.currentToolPermissionMode()).toBe("full_access");
    },
  );

  test("captures a new session mode once instead of following later default changes", () => {
    const harness = modeHarness();
    harness.controller.setToolPermissionMode("ask");
    harness.controller.initializeSessionMode("new");
    harness.controller.setToolPermissionMode("full_plus");
    harness.selectSession("new");
    expect(harness.controller.currentToolPermissionMode()).toBe("ask");
  });

  test("does not grant an unavailable mode or silently erase a restored choice", () => {
    const harness = modeHarness(false);
    harness.controller.setToolPermissionMode("full_plus");
    expect(harness.state.sessionModes).toEqual({});
    expect(harness.preferences.loadLastToolPermissionMode(normalizeToolPermissionMode)).toBe("full_access");
    expect(harness.recordControlEvent).toHaveBeenCalledOnce();
    harness.preferences.saveSessionModes({ one: { toolPermissionMode: "full_plus", savedAt: 10 } });
    harness.state.sessionModes = harness.preferences.loadSessionModes(normalizeToolPermissionMode);
    harness.controller.renderPermissionMode();
    expect(harness.controller.currentToolPermissionMode()).toBe("full_plus");
    expect(harness.state.sessionModes.one?.toolPermissionMode).toBe("full_plus");
    harness.controller.setToolPermissionMode("ask");
    expect(harness.controller.currentToolPermissionMode()).toBe("ask");
  });

  test("queued modes survive refresh and later changes to the session selection", () => {
    const storage = memoryStorage();
    const harness = modeHarness();
    const queue = createSessionComposerQueue({ storage });
    const scope = { environmentId: "prod", sessionId: "one" };
    const item = {
      waitForRequestId: "running", text: "queued task", attachments: [],
      agentMode: "reasoning", toolPermissionMode: harness.controller.currentToolPermissionMode(),
    };
    queue.enqueue(scope, item);
    harness.controller.setToolPermissionMode("full_plus");
    item.toolPermissionMode = "full_plus";
    const restored = createSessionComposerQueue({ storage });
    const first = restored.releaseForTerminal(scope, "running");
    expect(first?.item.toolPermissionMode).toBe("full_access");
    restored.bindReleasedSuccess(scope, first!.releaseToken, "second");
    restored.enqueue(scope, { ...item, waitForRequestId: "second" });
    harness.controller.setToolPermissionMode("ask");
    expect(restored.releaseForTerminal(scope, "second")?.item.toolPermissionMode).toBe("full_plus");
  });
});
