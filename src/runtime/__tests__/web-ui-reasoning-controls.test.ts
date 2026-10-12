import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module.
import { canChooseReasoning, renderReasoningModeField, syncReasoningModeField, retainedReasoningMode } from "../../web-ui/app/lib/reasoning-controls.js";
// @ts-expect-error Browser-only JavaScript module.
import { createReasoningModeController } from "../../web-ui/app/controllers/reasoning-mode-controller.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
// @ts-expect-error Browser-only JavaScript module.
import { createSparkChatSettings } from "../../web-ui/app/components/spark-chat/settings.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function domRoot() {
  return new FakeElement("section", { activeElement: null } as ConstructorParameters<typeof FakeElement>[1]);
}

describe("reasoning controls reflect active model permission", () => {
  test.each([undefined, false, "true", 1])("requires explicit true, received %s", (flag) => {
    expect(canChooseReasoning({ supportsThinking: flag })).toBe(false);
    expect(renderReasoningModeField("deep", { supportsThinking: flag })).toContain(" disabled");
  });
  test("changing a form model locks and unlocks reasoning while retaining its stored mode", () => {
    const root = domRoot();
    root.innerHTML = '<select name="modelProfileId"></select>' + renderReasoningModeField("deep", { supportsThinking: true });
    const model = root.querySelector('[name="modelProfileId"]')!;
    const mode = root.querySelector('[data-reasoning-mode]')!;
    model.value = "defaults"; mode.value = "deep";
    const profiles = [{ id: "defaults", supportsThinking: false }, { id: "enabled", supportsThinking: true }];
    syncReasoningModeField(root, profiles);
    expect(mode.disabled).toBe(true);
    expect(mode.textContent).toBe("Provider default");
    expect(retainedReasoningMode(root, "fast")).toBe("deep");
    model.value = "enabled";
    syncReasoningModeField(root, profiles);
    expect(mode.disabled).toBe(false);
    expect(mode.querySelector('[value="deep"]')!.hasAttribute("selected")).toBe(true);
  });
  test("chat opens permission content and never writes a mode while permission is off", async () => {
    let profile = { id: "one", supportsThinking: false };
    const state = { agentMode: "deep", supportedAgentModes: ["fast", "deep"], agentModeMenuOpen: true };
    const button = { classList: { toggle: vi.fn() }, setAttribute: vi.fn(), focus: vi.fn(), innerHTML: "" };
    const menu = Object.assign(domRoot(), { classList: { toggle: vi.fn() } });
    const client = { setAgentMode: vi.fn(async () => ({ mode: "fast" })) };
    const control = createReasoningModeController({ state, dom: { agentModeButton: button, agentModeMenu: menu }, client,
      selectedEnvironmentId: () => "prod", selectedModelProfile: () => profile, reloadModels: vi.fn(), recordControlEvent: vi.fn() });
    control.renderAgentMode();
    expect(menu.attributes.get("role")).toBe("dialog");
    expect(menu.querySelector("[data-reasoning-enable]")).not.toBeNull();
    expect(menu.querySelector("[data-mode]")).toBeNull();
    await expect(control.setAgentMode("fast")).resolves.toBe(false);
    expect(client.setAgentMode).not.toHaveBeenCalled();
    expect(state.agentMode).toBe("deep");
    profile = { id: "two", supportsThinking: true };
    control.renderAgentMode();
    expect(menu.attributes.get("role")).toBe("menu");
    await expect(control.setAgentMode("fast")).resolves.toBe(true);
    expect(client.setAgentMode).toHaveBeenCalledWith("fast", "prod");
  });
  test("SPARK settings block mode changes until its model permission is active", () => {
    const root = domRoot();
    const container = { querySelector: () => ({ prepend: vi.fn() }) };
    const onAgentModeChange = vi.fn();
    const settings = createSparkChatSettings({ root: container, documentRoot: { createElement: () => root },
      getAgentMode: () => "deep", getWebConfig: () => ({}), onAgentModeChange,
    });
    settings.render({ sessionId: "spark", supportsThinking: false }, "prod");
    const select = root.querySelector("[data-spark-agent-mode]")!;
    expect(select.disabled).toBe(true);
    expect(select.textContent).toContain("Provider default");
    select.value = "fast"; select.dispatch("change");
    expect(onAgentModeChange).not.toHaveBeenCalled();
    settings.render({ sessionId: "spark", supportsThinking: true }, "prod");
    expect(select.disabled).toBe(false);
    select.value = "fast"; select.dispatch("change");
    expect(onAgentModeChange).toHaveBeenCalledWith("fast");
  });
  test("Studio reads active model permission independently of its authoring catalog", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const data = String(url).includes("/chat/models")
        ? { profiles: [{ id: "enabled", supportsThinking: true }, { id: "defaults", supportsThinking: false }] }
        : { models: [{ id: "enabled" }, { id: "defaults" }, { id: "missing" }], operations: [] };
      return new Response(JSON.stringify(data));
    });
    const client = createRuntimeWebClient({ getConfig: () => ({ backend: "runtime" }), getEnvironmentId: () => "prod", fetchImpl, origin: "http://localhost" });
    const catalog = await client.getAutomationCatalog("one", "dev one");
    expect(catalog.models).toEqual([{ id: "enabled", supportsThinking: true }, { id: "defaults", supportsThinking: false }, { id: "missing", supportsThinking: false }]);
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).every((url) => url.includes("environment=dev%20one"))).toBe(true);
  });
});
