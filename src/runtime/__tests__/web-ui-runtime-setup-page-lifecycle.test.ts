import { describe, expect, test, vi } from "vitest";
import { bindRuntimeSetupPageLifecycle } from "../../web-ui/app/runtime-setup-page-lifecycle.js";
import { createRuntimeOnboardingController } from "../../web-ui/app/controllers/runtime-onboarding-controller.js";
import { createGuideHarness } from "./support/runtime-setup-guide-harness.js";

function dispatchPageTransition(
  page: EventTarget,
  type: string,
  persisted: boolean,
) {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  page.dispatchEvent(event);
}

function createLifecycleHarness(ready = false) {
  const guide = createGuideHarness();
  const page = new EventTarget();
  const state = {
    runtimeAvailability: { status: ready ? "ready" : "setup_required" },
  };
  const catalog = ready
    ? { profiles: [{ id: "default" }], availability: { status: "ready" } }
    : { profiles: [], availability: { status: "setup_required" } };
  const reloadModels = vi.fn(async () => {
    controller.beginCatalogLoad();
    controller.applyCatalog(catalog);
  });
  const controller = createRuntimeOnboardingController({
    state,
    guide: guide.guide,
    reloadModels,
    setMessageStatus: vi.fn(),
  });
  controller.bind();
  bindRuntimeSetupPageLifecycle({
    page,
    dispose: guide.guide.dispose,
    reloadModels,
  });
  return { ...guide, page, controller, reloadModels };
}

describe("runtime setup page lifecycle", () => {
  test("reconstructs active setup through catalog loading after a persisted restore and clears the key", async () => {
    const harness = createLifecycleHarness();
    await harness.ready();
    harness.changeProvider("openai");
    harness.submit();
    harness.inputModel("test-model");
    harness.inputKey("synthetic-secret");
    expect(harness.fields["api-key"].value).toBe("synthetic-secret");

    dispatchPageTransition(harness.page, "pagehide", true);
    expect(harness.container.innerHTML).toBe("");
    expect(harness.fields["api-key"].value).toBe("");

    dispatchPageTransition(harness.page, "pageshow", true);
    await harness.ready();
    expect(harness.reloadModels).toHaveBeenCalledOnce();
    expect(harness.loadSetup).toHaveBeenCalledTimes(2);
    expect(harness.container.hidden).toBe(false);
    expect(harness.conversationRegion.hidden).toBe(true);
    expect(harness.container.innerHTML).toContain(
      'data-runtime-setup-field="provider"',
    );
    expect(harness.container.innerHTML).not.toContain("synthetic-secret");
    expect(harness.saveSetup).not.toHaveBeenCalled();
    expect(harness.applySetup).not.toHaveBeenCalled();
  });

  test("does not repeat model loading on the initial pageshow", async () => {
    const harness = createLifecycleHarness();
    await harness.ready();
    dispatchPageTransition(harness.page, "pageshow", false);
    expect(harness.reloadModels).not.toHaveBeenCalled();
    expect(harness.loadSetup).toHaveBeenCalledOnce();
  });

  test("keeps ready chat outside onboarding after a persisted restore", async () => {
    const harness = createLifecycleHarness(true);
    dispatchPageTransition(harness.page, "pagehide", true);
    dispatchPageTransition(harness.page, "pageshow", true);
    await harness.ready();
    expect(harness.reloadModels).toHaveBeenCalledOnce();
    expect(harness.controller.isReady()).toBe(true);
    expect(harness.container.hidden).toBe(true);
    expect(harness.container.innerHTML).toBe("");
    expect(harness.conversationRegion.hidden).toBe(false);
    expect(harness.loadSetup).not.toHaveBeenCalled();
  });

  test("still clears both credential inputs when the page is discarded normally", async () => {
    const harness = createLifecycleHarness();
    await harness.ready();
    harness.inputKey("synthetic-chat-secret");
    harness.inputEmbeddingKey("synthetic-embedding-secret");
    dispatchPageTransition(harness.page, "pagehide", false);
    expect(harness.fields["api-key"].value).toBe("");
    expect(harness.fields["embedding-key"].value).toBe("");
    expect(harness.container.innerHTML).toBe("");
    expect(harness.reloadModels).not.toHaveBeenCalled();
  });
});
