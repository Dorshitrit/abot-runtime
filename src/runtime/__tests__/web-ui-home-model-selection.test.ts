import { describe, expect, test, vi } from "vitest";

import {
  createRuntimeSelectionController,
  type RuntimeSelectionControllerDependencies,
} from "../../web-ui/app/controllers/runtime-selection-controller.js";

function selectionControl(value = "") {
  const options = [
    { value: "vision", textContent: "Vision" },
    { value: "text", textContent: "Text" },
  ];
  return {
    value, options, title: "", innerHTML: "", hidden: false, disabled: false,
    classList: { toggle: vi.fn() },
    setAttribute: vi.fn(), focus: vi.fn(), append: vi.fn(), appendChild: vi.fn(),
    querySelectorAll: () => [],
  };
}

function createSelectionHarness() {
  let composerSessionId = "home-draft";
  const state: RuntimeSelectionControllerDependencies["state"] = {
    config: null, pinnedSessionIds: [],
    currentSessionId: "existing-chat",
    sessionModels: { "existing-chat": "vision" },
    sessionModes: { "existing-chat": { toolPermissionMode: "full_access" } },
    lastModelByEnvironment: { dev: "vision" },
    agentMode: "reasoning", supportedAgentModes: ["reasoning"],
    agentModeMenuOpen: false, permissionModeMenuOpen: false, agentPickerOpen: false,
    modelProfiles: [
      { id: "vision", supportsImageInput: true },
      { id: "text", supportsImageInput: false },
    ],
    defaultModelProfileId: "vision",
  };
  const dom = {
    environmentSelect: selectionControl("dev"),
    modelSelect: selectionControl("text"),
    agentPickerButton: selectionControl(), agentPickerMenu: selectionControl(),
    permissionModeButton: selectionControl(), permissionModeMenu: selectionControl(),
    agentModeButton: selectionControl(), agentModeMenu: selectionControl(),
  };
  const controller = createRuntimeSelectionController({
    state, dom,
    getComposerSessionId: () => composerSessionId,
    preferences: {
      loadPinnedSessions: () => [],
      loadSessionModes: () => ({}),
      saveSessionModes: vi.fn(),
      loadModelPreferences: () => ({ sessionModels: {}, lastModelByEnvironment: {} }),
      saveModelPreferences: vi.fn(),
    },
    modelSelector: { sync: vi.fn() },
    client: {
      getAgentMode: async () => ({}),
      setAgentMode: async () => ({}),
      listModels: async () => ({}),
    },
    recordControlEvent: vi.fn(),
    onAttachmentPolicyChange: vi.fn(),
  });
  return {
    state, dom, controller,
    selectComposerSession(sessionId: string) {
      composerSessionId = sessionId;
    },
  };
}

describe("web ui Home model and permission scope", () => {
  test("saves Home selections to its draft without changing the active Chat", () => {
    const { state, controller } = createSelectionHarness();

    controller.rememberModelSelection();
    controller.setToolPermissionMode("ask");

    expect(state.currentSessionId).toBe("existing-chat");
    expect(state.sessionModels).toEqual({
      "existing-chat": "vision",
      "home-draft": "text",
    });
    expect(state.sessionModes["existing-chat"]).toEqual({
      toolPermissionMode: "full_access",
    });
    expect(state.sessionModes["home-draft"]).toMatchObject({
      toolPermissionMode: "ask",
    });
  });

  test("restores each workspace selection and checks image support by explicit model", () => {
    const harness = createSelectionHarness();
    harness.controller.rememberModelSelection();
    expect(harness.controller.selectedModelSupportsImageInput()).toBe(false);
    expect(harness.controller.selectedModelSupportsImageInput("vision")).toBe(true);

    harness.selectComposerSession("existing-chat");
    harness.controller.applyModelSelection();

    expect(harness.dom.modelSelect.value).toBe("vision");
    expect(harness.controller.selectedModelSupportsImageInput()).toBe(true);
    expect(harness.controller.selectedModelSupportsImageInput("text")).toBe(false);

    harness.selectComposerSession("home-draft");
    harness.controller.applyModelSelection();
    expect(harness.dom.modelSelect.value).toBe("text");
  });
});
