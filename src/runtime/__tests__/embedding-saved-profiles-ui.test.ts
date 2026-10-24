import { describe, expect, test, vi } from "vitest";
import {
  createEmbeddingSetupHarness as harness,
  embeddingProfiles as profiles,
  embeddingStatus as status,
} from "./support/embedding-saved-profiles-fixture.js";

describe("saved embedding profile cards", () => {
  test("selects exact read-only provider/model without probing; explicit enable sends the saved ID", async () => {
    const h = await harness();
    h.choose("cpp-qwen");
    expect(h.element('[data-memory-saved-profile="cpp-qwen"]').attributes.get("aria-pressed")).toBe("true");
    expect(h.field("provider").value).toBe("cpp");
    expect(h.field("model").value).toBe("qwen3-embedding:0.6b");
    for (const name of ["provider", "model", "profile-label"]) expect(h.field(name).disabled).toBe(true);
    expect(h.root.querySelector('[data-memory-action="save-profile"]')).toBeNull();
    expect(h.enableMemory).not.toHaveBeenCalled();
    expect(h.saveProfile).not.toHaveBeenCalled();
    expect(h.discoverModels).not.toHaveBeenCalled();

    h.click("enable");
    await vi.waitFor(() => expect(h.enableMemory).toHaveBeenCalledWith({
      providerId: "cpp", model: "qwen3-embedding:0.6b", profileId: "cpp-qwen", emitClientEvents: false,
    }, "dev"));
    expect(h.saveProfile).not.toHaveBeenCalled();
  });

  test("new profile opens an editable blank name/model and cannot activate before it is saved", async () => {
    const h = await harness();
    h.choose("cpp-qwen");
    h.newProfile();
    expect(h.field("profile-label").value).toBe("");
    expect(h.field("model").value).toBe("");
    for (const name of ["provider", "model", "profile-label"]) expect(h.field(name).disabled).toBe(false);
    expect(h.root.querySelector('[data-memory-action="enable"]')).toBeNull();

    h.click("save-profile");
    await Promise.resolve();
    expect(h.saveProfile).not.toHaveBeenCalled();
    expect(h.enableMemory).not.toHaveBeenCalled();
    expect(h.discoverModels).not.toHaveBeenCalled();
    expect(h.root.textContent).toContain("give the profile a name");
  });

  test("save creates a card without enabling; a separate activation targets the returned exact ID", async () => {
    const h = await harness();
    h.fillDraft("My Ollama", "ollama");
    h.click("save-profile");
    await vi.waitFor(() => expect(h.endRuntimeMutation).toHaveBeenCalledOnce());

    expect(h.saveProfile).toHaveBeenCalledWith({
      providerId: "ollama", model: "qwen3-embedding:0.6b", label: "My Ollama",
    }, "dev");
    expect(h.element('[data-memory-saved-profile="saved-choice"]').attributes.get("aria-pressed")).toBe("true");
    expect(h.field("provider").value).toBe("ollama");
    expect(h.field("model").disabled).toBe(true);
    expect(h.enableMemory).not.toHaveBeenCalled();
    expect(h.discoverModels).not.toHaveBeenCalled();

    h.click("enable");
    await vi.waitFor(() => expect(h.enableMemory).toHaveBeenCalledWith({
      providerId: "ollama", model: "qwen3-embedding:0.6b", profileId: "saved-choice", emitClientEvents: false,
    }, "dev"));
    expect(h.saveProfile).toHaveBeenCalledOnce();
  });

  test("save holds mutation ownership through refresh and prevents duplicate actions", async () => {
    let finishRefresh!: (value: boolean) => void;
    const refreshRuntimeConfig = vi.fn(() => new Promise<boolean>((resolve) => { finishRefresh = resolve; }));
    const h = await harness({ refreshRuntimeConfig });
    h.fillDraft();
    h.click("save-profile");
    await vi.waitFor(() => expect(refreshRuntimeConfig).toHaveBeenCalledOnce());
    expect(h.endRuntimeMutation).not.toHaveBeenCalled();
    expect(h.field("model").disabled).toBe(true);
    h.click("save-profile");
    expect(h.saveProfile).toHaveBeenCalledOnce();
    expect(h.enableMemory).not.toHaveBeenCalled();
    finishRefresh(true);
    await vi.waitFor(() => expect(h.endRuntimeMutation).toHaveBeenCalledOnce());
  });

  test("late save cannot replace the new environment's cards or refresh its configuration", async () => {
    let resolveSave!: (value: unknown) => void;
    const saveProfile = vi.fn(() => new Promise((resolve) => { resolveSave = resolve; }));
    const h = await harness({
      saveProfile,
      loadStatus: async (id: string) => ({ status: id === "prod" ? { ...status, embeddingProfiles: [] } : status }),
    });
    h.fillDraft();
    h.click("save-profile");
    await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledOnce());
    h.environment("prod");
    await h.setup.load();
    const productionMarkup = h.root.innerHTML;
    resolveSave({ status, profileId: "cpp-qwen" });
    await vi.waitFor(() => expect(h.endRuntimeMutation).toHaveBeenCalledOnce());
    expect(h.root.innerHTML).toBe(productionMarkup);
    expect(h.root.querySelector('[data-memory-saved-profile="cpp-qwen"]')).toBeNull();
    expect(h.refreshRuntimeConfig).not.toHaveBeenCalled();
  });

  test("unavailable cards cannot silently select a fallback connection", async () => {
    const unavailable = { id: "absent", label: "Missing", providerId: "chat-only", model: "private-embedding" };
    const h = await harness({
      loadStatus: async () => ({ status: { ...status, embeddingProfiles: [...profiles, unavailable] } }),
    });
    expect(h.element('[data-memory-saved-profile="absent"]').disabled).toBe(true);
    h.choose("absent");
    expect(h.element('[data-memory-saved-profile="cloud-small"]').attributes.get("aria-pressed")).toBe("true");
    expect(h.field("model").value).toBe("text-embedding-3-small");
    expect(h.enableMemory).not.toHaveBeenCalled();
  });

  test("configured unavailable profile cannot probe against a fallback connection", async () => {
    const unavailable = { id: "absent", label: "Missing", providerId: "chat-only", model: "private-embedding" };
    const h = await harness({
      loadStatus: async () => ({ status: {
        ...status, profileId: unavailable.id, providerId: unavailable.providerId,
        model: unavailable.model, embeddingProfiles: [unavailable],
      } }),
    });
    h.click("enable");
    await Promise.resolve();
    expect(h.enableMemory).not.toHaveBeenCalled();
    expect(h.saveProfile).not.toHaveBeenCalled();
    expect(h.discoverModels).not.toHaveBeenCalled();
    expect(h.field("provider").value).toBe("chat-only");
  });

  test("blocked configuration ownership prevents saving a named draft", async () => {
    const h = await harness({ beginRuntimeMutation: () => false });
    h.fillDraft();
    h.click("save-profile");
    await Promise.resolve();
    expect(h.saveProfile).not.toHaveBeenCalled();
    expect(h.enableMemory).not.toHaveBeenCalled();
  });
});
