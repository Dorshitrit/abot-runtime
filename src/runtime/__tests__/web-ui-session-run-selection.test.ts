import { afterEach, expect, test, vi } from "vitest";
import { createRuntimeSelectionController } from "../../web-ui/app/controllers/runtime-selection-controller.js";
import { createSessionRunSelection } from "../../web-ui/app/controllers/session-run-selection.js";
import { bindContextReplayEvents } from "../../web-ui/app/lib/context-window-replay.js";

function control(value = "") {
  const options: any[] = [];
  return {
    value, options, dataset: {} as Record<string, string>, disabled: false, hidden: false, title: "", textContent: "", innerHTML: "",
    classList: { toggle: vi.fn() }, setAttribute: vi.fn(), focus: vi.fn(),
    querySelectorAll: () => [], append: vi.fn(),
    appendChild(option: any) { options.push(option); },
  };
}
const selectedRun = {
  requestId: "external", generation: "g1", status: "streaming", selectedAt: 20,
  primaryProfileId: "luna", agentMode: "deep", rootModelSteps: ["execution.decision"],
  effectiveReasoning: { profileId: "luna", modelStep: "execution.decision", reasoningEffort: "high" },
};
function fixture(hasUnsentDraft = () => true) {
  let home = false;
  const state = {
    config: null, currentSessionId: "chat", sessionViewVersion: 1, pinnedSessionIds: [], sessionModes: {},
    sessionModels: { chat: "gemma", home: "luna" } as Record<string, string>, lastModelByEnvironment: { dev: "gemma" },
    agentMode: "reasoning", supportedAgentModes: ["fast", "reasoning", "deep"], agentModeMenuOpen: false,
    permissionModeMenuOpen: false, agentPickerOpen: false, defaultModelProfileId: "gemma",
    modelProfiles: [{ id: "gemma", supportsThinking: true }, { id: "luna", supportsThinking: true }],
  };
  const dom = { environmentSelect: control("dev"), modelSelect: control("gemma"),
    agentModeButton: control(), agentModeMenu: control(), agentPickerButton: control(), agentPickerMenu: control(),
    permissionModeButton: control(), permissionModeMenu: control() };
  dom.modelSelect.options.push({ value: "gemma", dataset: {} }, { value: "luna", dataset: {} });
  const saved = vi.fn(), setAgentMode = vi.fn(async (mode) => ({ mode }));
  const modelSync = vi.fn(), attachmentPolicy = vi.fn();
  const loadReasoningPreference = vi.fn();
  vi.stubGlobal("document", { createElement: () => control() });
  const selection = createRuntimeSelectionController({
    state, dom, getComposerSessionId: () => home ? "home" : state.currentSessionId, getComposerIsHome: () => home, hasUnsentDraft,
    preferences: { loadPinnedSessions: () => [], loadSessionModes: () => ({}), saveSessionModes: vi.fn(),
      loadLastToolPermissionMode: () => "ask", saveLastToolPermissionMode: vi.fn(),
      loadModelPreferences: () => ({ sessionModels: state.sessionModels, lastModelByEnvironment: state.lastModelByEnvironment }),
      loadReasoningPreference,
      saveModelPreferences: saved },
    modelSelector: { sync: modelSync }, client: { getAgentMode: async () => ({}), listModels: async () => ({}), setAgentMode },
    recordControlEvent: vi.fn(), onAttachmentPolicyChange: attachmentPolicy,
  } as any);
  const scope = () => ({ environmentId: "dev", sessionId: state.currentSessionId, viewVersion: state.sessionViewVersion });
  return { selection, state, dom, saved, setAgentMode, modelSync, attachmentPolicy, loadReasoningPreference, scope, setHome(value: boolean) { home = value; selection.applyModelSelection(); } };
}
afterEach(() => vi.unstubAllGlobals());

test("clearing a deleted conversation immediately restores preferred model and reasoning", () => {
  const f = fixture();
  f.selection.applySessionSnapshot({ sessionId: "chat", modelSelection: selectedRun }, f.scope());
  expect(f.dom.modelSelect.value).toBe("luna");
  expect(f.dom.agentModeButton.innerHTML).toContain("High");
  f.state.currentSessionId = "";
  f.selection.clearRunSelection();
  expect(f.dom.modelSelect.value).toBe("gemma");
  expect(f.dom.agentModeButton.innerHTML).toContain("Reasoning");
  expect(f.selection.selectedAgentMode()).toBe("reasoning");
  expect(f.saved).not.toHaveBeenCalled();
  expect(f.setAgentMode).not.toHaveBeenCalled();
});

test("external run restores actual model and reasoning without changing preferred settings", () => {
  const f = fixture();
  f.selection.applySessionSnapshot({ sessionId: "chat", modelSelection: selectedRun }, f.scope());
  expect(f.dom.modelSelect.value).toBe("luna");
  expect(f.dom.agentModeButton.innerHTML).toContain("High");
  expect(f.selection.selectedAgentMode()).toBe("deep");
  expect(f.state.agentMode).toBe("reasoning");
  expect(f.state.lastModelByEnvironment.dev).toBe("gemma");
  f.selection.rememberModelSelection();
  expect(f.saved).not.toHaveBeenCalled();
  expect(f.setAgentMode).not.toHaveBeenCalled();
  f.setHome(true);
  expect(f.dom.modelSelect.value).toBe("gemma");
  expect(f.selection.selectedAgentMode()).toBe("reasoning");
  expect(f.dom.agentModeButton.innerHTML).toContain("Reasoning");
});

test("Home follows the latest manual preference after a different Home draft choice", () => {
  const f = fixture();
  f.setHome(true);
  f.dom.modelSelect.value = "luna";
  f.selection.rememberModelSelection({ explicit: true });
  f.setHome(false);
  f.dom.modelSelect.value = "gemma";
  f.selection.rememberModelSelection({ explicit: true });
  f.setHome(true);
  expect(f.dom.modelSelect.value).toBe("gemma");
  f.selection.rememberModelSelection();
  expect(f.state.sessionModels.home).toBe("gemma");
  expect(f.saved).toHaveBeenCalledTimes(2);
});

test("manual next-message choice survives same-run telemetry and yields to a new authoritative run", () => {
  const f = fixture();
  f.selection.applySessionSnapshot({ sessionId: "chat", modelSelection: selectedRun }, f.scope());
  f.dom.modelSelect.value = "gemma";
  f.selection.rememberModelSelection({ explicit: true });
  f.selection.observeRunEvent({ name: "request.model.selected", ...selectedRun, environmentId: "dev", sessionId: "chat" });
  expect(f.selection.selectedModelPreference()).toEqual({ profileId: "gemma" });
  f.selection.observeRunEvent({ name: "request.model.selected", ...selectedRun, requestId: "next", generation: "g2", selectedAt: 30, environmentId: "dev", sessionId: "chat" });
  expect(f.selection.selectedModelPreference()).toEqual({ profileId: "luna" });
  expect(f.state.lastModelByEnvironment.dev).toBe("gemma");
});

test("unavailable recorded model remains visible and blocks silent substitution on send", () => {
  const f = fixture();
  f.selection.applySessionSnapshot({ sessionId: "chat", modelSelection: { ...selectedRun, primaryProfileId: "removed", primaryModel: { label: "Old model", provider: "openai", model: "old" } } }, f.scope());
  expect(f.dom.modelSelect.value).toBe("removed");
  expect(f.dom.modelSelect.options.at(-1).textContent).toBe("Old model (unavailable)");
  expect(() => f.selection.selectedModelPreference()).toThrow("no longer available");
  expect(f.state.lastModelByEnvironment.dev).toBe("gemma");
});

test("manual reasoning remains selected despite later telemetry from the current run", async () => {
  const f = fixture();
  f.selection.applySessionSnapshot({ sessionId: "chat", modelSelection: selectedRun }, f.scope());
  await f.selection.setAgentMode("fast");
  expect(f.selection.selectedAgentMode()).toBe("fast");
  f.selection.observeRunEvent({ name: "context.window.snapshot", ...selectedRun, environmentId: "dev", sessionId: "chat",
    profileId: "luna", modelStep: "execution.decision", admissionOutcome: "accepted", reasoningEffort: "high", seqNo: 10 });
  expect(f.selection.selectedAgentMode()).toBe("fast");
  expect(f.dom.agentModeButton.innerHTML).toContain("Low");
  expect(f.dom.agentModeButton.innerHTML).not.toContain("High");
});

test("new canonical generation cannot be replaced by stale selected-model events", () => {
  const scope = { environmentId: "dev", sessionId: "chat", viewVersion: 1 };
  const owner = createSessionRunSelection({ getScope: () => scope, getComposerScope: () => scope,
    getRequestGeneration: () => "g1" });
  owner.applySnapshot({ sessionId: "chat", modelSelection: selectedRun }, scope);
  expect(owner.observeEvent({ ...selectedRun, ...scope, name: "request.model.selected", generation: "stale", primaryProfileId: "gemma", selectedAt: 999 })).toBe(false);
  expect(owner.run()?.primaryProfileId).toBe("luna");
  expect(owner.run()?.effectiveReasoning?.reasoningEffort).toBe("high");
});

test("snapshot reasoning rejects older replay without mixing transport sequence domains", () => {
  const scope = { environmentId: "dev", sessionId: "chat", viewVersion: 1 };
  const owner = createSessionRunSelection({ getScope: () => scope, getComposerScope: () => scope });
  owner.applySnapshot({ sessionId: "chat", modelSelection: { ...selectedRun, reasoningEventSequence: 20 } }, scope);
  const payload = { type: "event", name: "context.window.snapshot", requestId: "external", generation: "g1",
    profileId: "luna", modelStep: "execution.decision", admissionOutcome: "accepted", reasoningEffort: "low" };
  const [earlier] = bindContextReplayEvents([{ ...payload, seqNo: 900, eventSequence: 10 }], { ...scope, requestId: "external", generation: "g1" });
  expect(owner.observeEvent(earlier)).toBe(false);
  expect(owner.run()?.effectiveReasoning?.reasoningEffort).toBe("high");
  expect(owner.observeEvent({ ...payload, ...scope, seqNo: 1, eventSequence: 21 })).toBe(true);
  expect(owner.run()?.effectiveReasoning?.reasoningEffort).toBe("low");
});

test("recorded reasoning preference binds the selected model and never follows another profile", () => {
  const scope = { environmentId: "dev", sessionId: "chat" };
  const owner = createSessionRunSelection({ getScope: () => scope, getComposerScope: () => scope });
  owner.applySnapshot({ sessionId: "chat", modelSelection: { ...selectedRun,
    reasoningPreference: { profileId: "luna", mode: "budget", budgetTokens: 128 } } }, scope);
  expect(owner.selectedReasoningPreference("luna")).toEqual({ profileId: "luna", mode: "budget", budgetTokens: 128 });
  owner.remember({ profileId: "gemma" });
  expect(owner.selectedReasoningPreference("gemma")).toBeUndefined();
  owner.applySnapshot({ sessionId: "chat", modelSelection: { ...selectedRun, requestId: "second", selectedAt: 21,
    reasoningPreference: { profileId: "gemma", mode: "off" } } }, scope);
  expect(owner.selectedReasoningPreference("luna")).toBeUndefined();
});

test("switching models discards the previous pending budget and restores each model's saved preference", () => {
  const scope = { environmentId: "dev", sessionId: "chat" };
  const owner = createSessionRunSelection({ getScope: () => scope, getComposerScope: () => scope });
  const luna = { profileId: "luna", mode: "budget" as const, budgetTokens: 128 };
  const gemma = { profileId: "gemma", mode: "budget" as const, budgetTokens: 256 };
  owner.applySnapshot({ sessionId: "chat", modelSelection: selectedRun }, scope);
  owner.remember({ reasoningPreference: luna });
  expect(owner.selectedReasoningPreference("luna", luna)).toEqual(luna);
  owner.remember({ profileId: "gemma" });
  expect(owner.selectedReasoningPreference("gemma", gemma)).toEqual(gemma);
  expect(owner.override()).not.toHaveProperty("reasoningPreference");
  owner.remember({ profileId: "luna" });
  expect(owner.selectedReasoningPreference("luna", luna)).toEqual(luna);
  owner.remember({ reasoningPreference: undefined });
  expect(owner.selectedReasoningPreference("luna")).toBeUndefined();
  expect(owner.selectedReasoningPreference("gemma", gemma)).toEqual(gemma);
  owner.remember({ profileId: "gemma" });
  expect(owner.selectedReasoningPreference("gemma", gemma)).toEqual(gemma);
  expect(owner.selectedReasoningPreference("gemma", luna)).toBeUndefined();
});

test("only accepted same-profile root attempts supply reasoning and calibrated replacements clear it", () => {
  const scope = { environmentId: "dev", sessionId: "chat", viewVersion: 1 };
  const owner = createSessionRunSelection({ getScope: () => scope, getComposerScope: () => scope });
  owner.applySnapshot({ sessionId: "chat", modelSelection: selectedRun }, scope);
  const event = { name: "context.window.snapshot", requestId: "external", generation: "g1", ...scope,
    profileId: "luna", modelStep: "execution.decision", admissionOutcome: "accepted", reasoningEffort: "low", seqNo: 1 };
  expect(owner.observeEvent({ ...event, modelStep: "worker.payload" })).toBe(false);
  expect(owner.observeEvent({ ...event, admissionOutcome: "rejected" })).toBe(false);
  expect(owner.observeEvent({ ...event, generation: "stale" })).toBe(false);
  expect(owner.run()?.effectiveReasoning?.reasoningEffort).toBe("high");
  expect(owner.observeEvent(event)).toBe(true);
  expect(owner.run()?.effectiveReasoning?.reasoningEffort).toBe("low");
  owner.observeEvent({ ...event, profileId: "other", seqNo: 2 });
  expect(owner.run()?.effectiveReasoning).toBeUndefined();
});

test("repeated semantic no-ops advance ordering without rebuilding model or reasoning controls", () => {
  const f = fixture();
  f.selection.applySessionSnapshot({ sessionId: "chat", modelSelection: selectedRun }, f.scope());
  expect(f.attachmentPolicy).toHaveBeenCalledOnce();
  f.modelSync.mockClear(); f.dom.agentModeButton.setAttribute.mockClear(); f.attachmentPolicy.mockClear();
  for (let sequence = 1; sequence <= 1000; sequence += 1) {
    f.selection.observeRunEvent({ ...selectedRun, ...f.scope(), name: "context.window.snapshot", profileId: "luna",
      modelStep: "execution.decision", admissionOutcome: "accepted", reasoningEffort: "high", eventSequence: sequence });
    f.selection.applySessionSnapshot({ sessionId: "chat", modelSelection: { ...selectedRun, reasoningEventSequence: sequence } }, f.scope());
  }
  f.selection.observeRunEvent({ ...selectedRun, ...f.scope(), name: "context.window.snapshot", profileId: "luna",
    modelStep: "execution.decision", admissionOutcome: "accepted", reasoningEffort: "low", eventSequence: 500 });
  expect(f.modelSync).not.toHaveBeenCalled();
  expect(f.dom.agentModeButton.setAttribute).not.toHaveBeenCalled();
  expect(f.attachmentPolicy).not.toHaveBeenCalled();
  expect(f.dom.agentModeButton.innerHTML).toContain("High");
});

test("Home ignores varying run telemetry without rebuilding its preferred controls", () => {
  const f = fixture();
  f.selection.applySessionSnapshot({ sessionId: "chat", modelSelection: selectedRun }, f.scope());
  f.setHome(true); f.modelSync.mockClear(); f.dom.agentModeButton.setAttribute.mockClear();
  for (let sequence = 1; sequence <= 1000; sequence += 1)
    f.selection.observeRunEvent({ ...selectedRun, ...f.scope(), name: "context.window.snapshot", profileId: "luna",
      modelStep: "execution.decision", admissionOutcome: "accepted", reasoningEffort: sequence % 2 ? "low" : "high", eventSequence: sequence });
  expect(f.modelSync).not.toHaveBeenCalled();
  expect(f.dom.agentModeButton.setAttribute).not.toHaveBeenCalled();
  expect(f.dom.modelSelect.value).toBe("gemma");
  f.setHome(false);
  expect(f.dom.modelSelect.value).toBe("luna");
  expect(f.dom.agentModeButton.innerHTML).toContain("High");
});

test("cursorless same-request snapshots cannot replace fresher live reasoning", () => {
  const f = fixture();
  f.selection.applySessionSnapshot({ sessionId: "chat", modelSelection: selectedRun }, f.scope());
  f.selection.observeRunEvent({ ...selectedRun, ...f.scope(), name: "context.window.snapshot", profileId: "luna",
    modelStep: "execution.decision", admissionOutcome: "accepted", reasoningEffort: "low", eventSequence: 10 });
  f.modelSync.mockClear();
  f.selection.applySessionSnapshot({ sessionId: "chat", modelSelection: selectedRun }, f.scope());
  expect(f.modelSync).not.toHaveBeenCalled();
  expect(f.dom.agentModeButton.innerHTML).toContain("Low");
});

test("selection projection discards unrelated diagnostics and transport fields", () => {
  const scope = { environmentId: "dev", sessionId: "chat" };
  const owner = createSessionRunSelection({ getScope: () => scope, getComposerScope: () => scope });
  owner.observeEvent({ ...selectedRun, ...scope, name: "request.model.selected", payload: { large: "x".repeat(100000) }, seqNo: 999 });
  expect(owner.run()).not.toHaveProperty("payload");
  expect(owner.run()).not.toHaveProperty("seqNo");
  expect(owner.run()).not.toHaveProperty("name");
});

test("irrelevant token and tool events do not read preferences or render selection controls", () => {
  const f = fixture();
  f.selection.applySessionSnapshot({ sessionId: "chat", modelSelection: selectedRun }, f.scope());
  f.modelSync.mockClear(); f.loadReasoningPreference.mockClear();
  for (let index = 0; index < 1000; index += 1)
    f.selection.observeRunEvent({ ...f.scope(), requestId: "external", generation: "g1", type: "event",
      name: index % 2 ? "response.delta" : "tool.progress", delta: "token", eventSequence: index + 1 });
  expect(f.modelSync).not.toHaveBeenCalled();
  expect(f.loadReasoningPreference).not.toHaveBeenCalled();
});

test("retiring the visible empty choice reconciles model and reasoning once without preference writes", async () => {
  let unsent = true;
  const f = fixture(() => unsent);
  f.selection.applySessionSnapshot({ sessionId: "chat", modelSelection: selectedRun }, f.scope());
  f.dom.modelSelect.value = "gemma"; f.selection.rememberModelSelection({ explicit: true });
  await f.selection.setAgentMode("fast");
  f.modelSync.mockClear(); f.saved.mockClear(); f.attachmentPolicy.mockClear();
  expect(f.selection.pruneEmptyDraftSelections(f.scope())).toBe(false);
  expect(f.dom.modelSelect.value).toBe("gemma");
  expect(f.selection.selectedAgentMode()).toBe("fast");
  unsent = false;
  expect(f.selection.pruneEmptyDraftSelections(f.scope())).toBe(true);
  expect(f.dom.modelSelect.value).toBe("luna");
  expect(f.selection.selectedAgentMode()).toBe("deep");
  expect(f.dom.agentModeButton.innerHTML).toContain("High");
  expect(f.modelSync).toHaveBeenCalledOnce();
  expect(f.attachmentPolicy).toHaveBeenCalledOnce();
  expect(f.saved).not.toHaveBeenCalled();
  expect(f.selection.pruneEmptyDraftSelections(f.scope())).toBe(false);
  expect(f.modelSync).toHaveBeenCalledOnce();
});
