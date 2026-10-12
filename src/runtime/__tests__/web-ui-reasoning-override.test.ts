import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module.
import { enableModelReasoning } from "../../web-ui/app/services/reasoning-override.js";
// @ts-expect-error Browser-only JavaScript module.
import { createReasoningOverridePrompt } from "../../web-ui/app/components/reasoning-override-prompt.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function fixture(supportsThinking = false) {
  const file = { id: "luna", registered: true, revision: "revision-one", config: { model: "luna", supportsThinking, generation: { temperature: 0.5 } } };
  const client = {
    loadConfigDashboard: vi.fn(async () => ({ dashboard: { files: { models: [file] } } })),
    saveConfigFile: vi.fn(async (_input: unknown) => ({ ok: true })),
    applyRuntimeConfiguration: vi.fn(async () => ({ activation: { status: "ready" } })),
  };
  return { file, client };
}

function promptFixture() {
  const document = { activeElement: null } as ConstructorParameters<typeof FakeElement>[1];
  const root = new FakeElement("div", document);
  const f = fixture();
  let environment = "prod";
  let profile = { id: "luna", label: "Luna", supportsThinking: false };
  const refreshModels = vi.fn(async () => true);
  const prompt = createReasoningOverridePrompt({ root, client: f.client,
    getEnvironmentId: () => environment, getProfile: () => profile,
    refreshModels, render: () => prompt.render(true),
  });
  prompt.render(true);
  const click = (action: string) => root.querySelector(`[data-reasoning-enable="${action}"]`)!.dispatch("click");
  return { ...f, root, prompt, click, refreshModels,
    changeEnvironment(value = "dev") { environment = value; prompt.render(true); },
  };
}

describe("explicit reasoning permission", () => {
  test("updates only the selected registered model flag with its revision", async () => {
    const f = fixture();
    const before = structuredClone(f.file);
    await enableModelReasoning(f.client, "luna", "prod");
    expect(f.client.loadConfigDashboard).toHaveBeenCalledWith("prod", { settled: true });
    expect(f.client.saveConfigFile).toHaveBeenCalledWith({ environmentId: "prod", kind: "model", id: "luna", expectedRevision: "revision-one", config: { ...before.config, supportsThinking: true } });
    expect(f.file).toEqual(before);
    expect(f.client.applyRuntimeConfiguration).not.toHaveBeenCalled();
  });
  test("does not rewrite already-saved permission", async () => {
    const f = fixture(true);
    await enableModelReasoning(f.client, "luna", "prod");
    expect(f.client.saveConfigFile).not.toHaveBeenCalled();
  });
  test("does not update unregistered or missing models", async () => {
    const f = fixture();
    f.file.registered = false;
    await expect(enableModelReasoning(f.client, "luna", "prod")).rejects.toThrow();
    await expect(enableModelReasoning(f.client, "missing", "prod")).rejects.toThrow();
    expect(f.client.saveConfigFile).not.toHaveBeenCalled();
  });
  test("saving for next start never applies or marks permission active", async () => {
    const f = promptFixture();
    f.click("later");
    await vi.waitFor(() => expect(f.root.textContent).toContain("Saved."));
    expect(f.client.applyRuntimeConfiguration).not.toHaveBeenCalled();
    expect(f.refreshModels).not.toHaveBeenCalled();
    expect(f.root.querySelector('[data-reasoning-enable="later"]')!.disabled).toBe(true);
  });
  test("apply is explicit, follows saving, and refreshes the active catalog", async () => {
    const f = promptFixture();
    f.click("now");
    await vi.waitFor(() => expect(f.refreshModels).toHaveBeenCalledOnce());
    expect(f.client.applyRuntimeConfiguration).toHaveBeenCalledWith("prod");
    expect(f.client.saveConfigFile.mock.invocationCallOrder[0]).toBeLessThan(f.client.applyRuntimeConfiguration.mock.invocationCallOrder[0]!);
  });
  test("busy owners retain saved permission without pretending it is active", async () => {
    const f = promptFixture();
    f.client.applyRuntimeConfiguration.mockResolvedValue({ activation: { status: "restart_required" } });
    f.click("now");
    await vi.waitFor(() => expect(f.root.textContent).toContain("Apply again"));
    expect(f.refreshModels).not.toHaveBeenCalled();
    expect(f.root.querySelector('[data-reasoning-enable="now"]')!.disabled).toBe(false);
  });
  test("save conflicts do not apply configuration", async () => {
    const f = promptFixture();
    f.client.saveConfigFile.mockRejectedValue(new Error("Configuration changed. Reload before saving."));
    f.click("now");
    await vi.waitFor(() => expect(f.root.textContent).toContain("Configuration changed."));
    expect(f.client.applyRuntimeConfiguration).not.toHaveBeenCalled();
  });
  test.each([false, true])("an environment switch (and return: %s) during save cannot trigger an apply for the new environment", async (returnToOriginal) => {
    const f = promptFixture();
    let release!: (value: { ok: boolean }) => void;
    f.client.saveConfigFile.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    f.click("now");
    await vi.waitFor(() => expect(f.client.saveConfigFile).toHaveBeenCalledOnce());
    f.changeEnvironment();
    if (returnToOriginal) f.changeEnvironment("prod");
    release({ ok: true });
    await Promise.resolve(); await Promise.resolve();
    expect(f.client.applyRuntimeConfiguration).not.toHaveBeenCalled();
    expect(f.root.textContent).not.toContain("Saved.");
  });
});
