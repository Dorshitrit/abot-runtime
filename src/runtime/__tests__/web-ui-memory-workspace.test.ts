import { beforeEach, describe, expect, test, vi } from "vitest";
import { ContextElement } from "./support/composer-context-window-dom.js";
// @ts-expect-error Browser component has no declaration surface.
import { createMemoryWorkspace } from "../../web-ui/app/components/long-term-memory/workspace.js";

const memory = vi.hoisted(() => ({
  mountSetup: vi.fn(),
  mountManager: vi.fn(),
  setOriginFilter: vi.fn(),
  focus: vi.fn(),
}));
vi.mock("../../web-ui/app/components/config-workspace.js", () => ({
  createConfigWorkspace: () => ({ prepareDiscardChanges: vi.fn() }),
}));
vi.mock("../../web-ui/app/components/model-setup/wizard.js", () => ({
  createModelSetupWizard: () => ({ isOpen: () => false }),
}));
vi.mock("../../web-ui/app/components/runtime-config-activation.js", () => ({
  createRuntimeConfigActivation: () => ({}),
}));
vi.mock("../../web-ui/app/components/plugins/manager.js", () => ({
  createPluginManager: () => ({}),
}));
vi.mock("../../web-ui/app/components/system-host/manager.js", () => ({
  createSystemHostConnectionManager: () => ({}),
}));
vi.mock("../../web-ui/app/components/system-host/setup-notice.js", () => ({
  createSystemHostSetupNotice: () => ({}),
}));
vi.mock("../../web-ui/app/components/long-term-memory-setup.js", () => ({
  createLongTermMemorySetup: () => ({ mount: memory.mountSetup }),
}));
vi.mock("../../web-ui/app/components/long-term-memory/manager.js", () => ({
  createLongTermMemoryManager: () => ({
    mount: memory.mountManager, focus: memory.focus,
  }),
}));
vi.mock("../../web-ui/app/controllers/long-term-memory/controller.js", () => ({
  createLongTermMemoryController: () => ({ setOriginFilter: memory.setOriginFilter }),
}));
// @ts-expect-error Browser composition module has no declaration surface.
import { createConfigurationFeature } from "../../web-ui/app/configuration-feature.js";

beforeEach(() => vi.clearAllMocks());

class MemoryElement extends ContextElement {
  value = "";
  focus = vi.fn();
  matches(selector: string) {
    const attribute = selector.match(/^\[data-memory-(tab|panel)="([^"]+)"\]$/);
    if (attribute) {
      const key = attribute[1] === "tab" ? "memoryTab" : "memoryPanel";
      return this.dataset[key] === attribute[2];
    }
    return super.matches(selector);
  }
}

function memoryDom() {
  const root = new MemoryElement("section");
  const memoriesTab = new MemoryElement("button");
  const setupTab = new MemoryElement("button");
  const memories = new MemoryElement("div");
  const setup = new MemoryElement("div");
  const recordDraft = new MemoryElement("textarea");
  const setupDraft = new MemoryElement("input");
  memoriesTab.dataset.memoryTab = "memories";
  setupTab.dataset.memoryTab = "setup";
  memories.dataset.memoryPanel = "memories";
  setup.dataset.memoryPanel = "setup";
  recordDraft.value = "Unsaved memory edit";
  setupDraft.value = "Unsubmitted embedding model";
  memories.appendChild(recordDraft);
  setup.appendChild(setupDraft);
  root.append(memoriesTab, setupTab, memories, setup);
  return { root, memoriesTab, setupTab, memories, setup, recordDraft, setupDraft };
}

describe("Memory workspace tabs", () => {
  test("defaults to Memories and preserves both panels, their drafts and listeners through repeated switches", () => {
    const dom = memoryDom();
    const saveDraft = vi.fn();
    dom.recordDraft.addEventListener("change", saveDraft);
    createMemoryWorkspace({ root: dom.root });
    expect(dom.memories.hidden).toBe(false);
    expect(dom.setup.hidden).toBe(true);
    expect(dom.memoriesTab.getAttribute("aria-selected")).toBe("true");
    expect(dom.memoriesTab.tabIndex).toBe(0);
    expect(dom.setupTab.tabIndex).toBe(-1);
    dom.setupTab.dispatch("click");
    expect(dom.memories.hidden).toBe(true);
    expect(dom.setup.hidden).toBe(false);
    expect(dom.setupTab.getAttribute("aria-selected")).toBe("true");
    expect(dom.memoriesTab.classList.contains("active")).toBe(false);
    expect(dom.setupTab.classList.contains("active")).toBe(true);
    dom.memoriesTab.dispatch("click");
    expect(dom.root.children).toContain(dom.memories);
    expect(dom.root.children).toContain(dom.setup);
    expect(dom.memories.children[0]).toBe(dom.recordDraft);
    expect(dom.setup.children[0]).toBe(dom.setupDraft);
    expect(dom.recordDraft.value).toBe("Unsaved memory edit");
    expect(dom.setupDraft.value).toBe("Unsubmitted embedding model");
    dom.recordDraft.dispatch("change");
    expect(saveDraft).toHaveBeenCalledOnce();
    expect(dom.memoriesTab.focus).not.toHaveBeenCalled();
    expect(dom.setupTab.focus).not.toHaveBeenCalled();
  });

  test("keyboard arrows wrap and Home/End select, reveal and focus the same native tabs", () => {
    const dom = memoryDom();
    createMemoryWorkspace({ root: dom.root });
    const preventDefault = vi.fn();
    dom.memoriesTab.dispatch("keydown", { key: "ArrowRight", preventDefault });
    expect(dom.setup.hidden).toBe(false);
    expect(dom.setupTab.focus).toHaveBeenCalledOnce();
    expect(dom.setupTab.tabIndex).toBe(0);
    expect(dom.memoriesTab.tabIndex).toBe(-1);
    dom.setupTab.dispatch("keydown", { key: "ArrowRight", preventDefault });
    expect(dom.memories.hidden).toBe(false);
    dom.memoriesTab.dispatch("keydown", { key: "ArrowLeft", preventDefault });
    expect(dom.setup.hidden).toBe(false);
    dom.setupTab.dispatch("keydown", { key: "Home", preventDefault });
    expect(dom.memories.hidden).toBe(false);
    dom.memoriesTab.dispatch("keydown", { key: "End", preventDefault });
    expect(dom.setup.hidden).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(5);
    dom.setupTab.dispatch("keydown", { key: "Tab", preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(5);
  });

  test("external activation is explicit about focus and invalid tabs leave the current panel visible", () => {
    const dom = memoryDom();
    const workspace = createMemoryWorkspace({ root: dom.root });
    workspace.activate("setup");
    expect(workspace.activate("unknown", { focus: true })).toBe(false);
    expect(dom.setup.hidden).toBe(false);
    expect(workspace.activate("memories", { focus: true })).toBe(true);
    expect(dom.memories.hidden).toBe(false);
    expect(dom.memoriesTab.focus).toHaveBeenCalledOnce();
    expect(createMemoryWorkspace({ root: undefined }).activate("memories")).toBe(false);
  });

  test("activity navigation opens Memories before the existing filter and manager focus, without remounting setup", () => {
    const dom = memoryDom();
    const runtimeClient = {
      loadLongTermMemoryStatus: vi.fn(), listLongTermMemories: vi.fn(),
      enableLongTermMemory: vi.fn(), disableLongTermMemory: vi.fn(),
    };
    const feature = createConfigurationFeature({
      dom: {
        configDashboard: { parentElement: {} },
        memoryWorkspacePanel: dom.root,
        memoryManagementRoot: dom.memories,
        memorySetupRoot: dom.setup,
      },
      runtimeClient,
      selectedEnvironmentId: () => "prod",
      recordControlEvent: vi.fn(),
    });
    dom.setupTab.dispatch("click");
    expect(dom.setup.hidden).toBe(false);
    for (const request of Object.values(runtimeClient)) expect(request).not.toHaveBeenCalled();
    memory.setOriginFilter.mockImplementationOnce(() => {
      expect(dom.memories.hidden).toBe(false);
      expect(dom.setup.hidden).toBe(true);
    });
    feature.showActivityMemories();
    expect(memory.setOriginFilter).toHaveBeenCalledExactlyOnceWith("passive_observation");
    expect(memory.focus).toHaveBeenCalledOnce();
    expect(memory.mountSetup).toHaveBeenCalledExactlyOnceWith(dom.setup);
    expect(memory.mountManager).toHaveBeenCalledExactlyOnceWith(dom.memories);
    expect(dom.setup.children[0]).toBe(dom.setupDraft);
    expect(dom.setupDraft.value).toBe("Unsubmitted embedding model");
  });
});
