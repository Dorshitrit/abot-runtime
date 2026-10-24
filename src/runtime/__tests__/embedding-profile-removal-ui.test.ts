import { describe, expect, test, vi } from "vitest";
import {
  createEmbeddingSetupHarness as harness,
  embeddingStatus as status,
} from "./support/embedding-saved-profiles-fixture.js";

describe("saved embedding profile removal", () => {
  test("requires inline confirmation and cancellation performs no mutation or provider probe", async () => {
    const h = await harness();
    h.clickSelector('[data-memory-remove-profile="cpp-qwen"]');
    expect(h.root.querySelector('[data-memory-confirm-remove="cpp-qwen"]')).not.toBeNull();
    expect(h.removeProfile).not.toHaveBeenCalled();

    h.clickSelector("[data-memory-cancel-remove]");
    expect(h.root.querySelector("[data-memory-confirm-remove]")).toBeNull();
    expect(h.root.querySelector('[data-memory-saved-profile="cpp-qwen"]')).not.toBeNull();
    expect(h.removeProfile).not.toHaveBeenCalled();
    expect(h.enableMemory).not.toHaveBeenCalled();
    expect(h.discoverModels).not.toHaveBeenCalled();
    expect(h.refreshRuntimeConfig).not.toHaveBeenCalled();
  });

  test("confirmed removal targets one saved ID and restores the configured selection without probing", async () => {
    const h = await harness();
    h.choose("cpp-qwen");
    h.clickSelector('[data-memory-remove-profile="cpp-qwen"]');
    h.clickSelector('[data-memory-confirm-remove="cpp-qwen"]');
    await vi.waitFor(() => expect(h.endRuntimeMutation).toHaveBeenCalledOnce());

    expect(h.removeProfile).toHaveBeenCalledExactlyOnceWith({ profileId: "cpp-qwen" }, "dev");
    expect(h.root.querySelector('[data-memory-saved-profile="cpp-qwen"]')).toBeNull();
    expect(h.element('[data-memory-saved-profile="cloud-small"]').attributes.get("aria-pressed")).toBe("true");
    expect(h.field("provider").value).toBe("cloud");
    expect(h.field("model").value).toBe("text-embedding-3-small");
    expect(h.root.querySelector('[data-memory-saved-profile="ollama-qwen"]')).not.toBeNull();
    expect(h.refreshRuntimeConfig).toHaveBeenCalledOnce();
    expect(h.enableMemory).not.toHaveBeenCalled();
    expect(h.saveProfile).not.toHaveBeenCalled();
    expect(h.discoverModels).not.toHaveBeenCalled();
  });

  test.each([true, false])("configured profile cannot be removed when memory enabled=%s", async (enabled) => {
    const h = await harness({ loadStatus: async () => ({ status: { ...status, enabled } }) });
    const remove = h.element('[data-memory-remove-profile="cloud-small"]');
    expect(remove.disabled).toBe(true);
    h.clickSelector('[data-memory-remove-profile="cloud-small"]');
    expect(h.root.querySelector("[data-memory-confirm-remove]")).toBeNull();
    expect(h.removeProfile).not.toHaveBeenCalled();
  });

  test("failed removal retains cards and selection, surfaces the error and releases ownership", async () => {
    const removeProfile = vi.fn(async () => { throw new Error("Cannot remove the saved profile."); });
    const h = await harness({ removeProfile });
    h.choose("cpp-qwen");
    h.clickSelector('[data-memory-remove-profile="cpp-qwen"]');
    h.clickSelector('[data-memory-confirm-remove="cpp-qwen"]');
    await vi.waitFor(() => expect(h.endRuntimeMutation).toHaveBeenCalledOnce());

    expect(removeProfile).toHaveBeenCalledExactlyOnceWith({ profileId: "cpp-qwen" }, "dev");
    expect(h.element('[data-memory-saved-profile="cpp-qwen"]').attributes.get("aria-pressed")).toBe("true");
    expect(h.root.textContent).toContain("Cannot remove the saved profile.");
    expect(h.refreshRuntimeConfig).not.toHaveBeenCalled();
    expect(h.enableMemory).not.toHaveBeenCalled();
    expect(h.discoverModels).not.toHaveBeenCalled();
    expect(h.element('[data-memory-confirm-remove="cpp-qwen"]').disabled).toBe(false);
  });

  test("a late removal response cannot replace another environment's profiles or refresh it", async () => {
    let resolveRemoval!: (value: unknown) => void;
    const removeProfile = vi.fn(() => new Promise((resolve) => { resolveRemoval = resolve; }));
    const production = {
      ...status,
      profileId: "prod-memory",
      embeddingProfiles: [{ id: "prod-memory", label: "Production", providerId: "cloud", model: status.model }],
    };
    const h = await harness({
      removeProfile,
      loadStatus: async (id: string) => ({ status: id === "prod" ? production : status }),
    });
    h.clickSelector('[data-memory-remove-profile="cpp-qwen"]');
    h.clickSelector('[data-memory-confirm-remove="cpp-qwen"]');
    await vi.waitFor(() => expect(removeProfile).toHaveBeenCalledOnce());
    h.environment("prod");
    await h.setup.load();
    const productionMarkup = h.root.innerHTML;
    resolveRemoval({ status: { ...status, embeddingProfiles: [] } });
    await vi.waitFor(() => expect(h.endRuntimeMutation).toHaveBeenCalledOnce());

    expect(h.root.innerHTML).toBe(productionMarkup);
    expect(h.root.querySelector('[data-memory-saved-profile="prod-memory"]')).not.toBeNull();
    expect(h.refreshRuntimeConfig).not.toHaveBeenCalled();
    expect(h.recordControlEvent).not.toHaveBeenCalled();
    expect(h.enableMemory).not.toHaveBeenCalled();
  });

  test("configuration ownership rejection leaves confirmation intact and makes no request", async () => {
    const h = await harness({ beginRuntimeMutation: () => false });
    h.clickSelector('[data-memory-remove-profile="cpp-qwen"]');
    h.clickSelector('[data-memory-confirm-remove="cpp-qwen"]');
    await Promise.resolve();

    expect(h.removeProfile).not.toHaveBeenCalled();
    expect(h.root.querySelector('[data-memory-confirm-remove="cpp-qwen"]')).not.toBeNull();
    expect(h.root.textContent).toContain("Save or reset configuration changes");
    expect(h.endRuntimeMutation).not.toHaveBeenCalled();
  });
});
