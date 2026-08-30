import { describe, expect, test, vi } from "vitest";

// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createLongTermMemorySetup } from "../../web-ui/app/components/long-term-memory-setup.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeRoot() {
  return {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function fakeInteractiveRoot() {
  let providerValue = "";
  let modelValue = "";
  const buttons = ["discover", "enable", "disable"].map((action) => ({
    dataset: { memoryAction: action },
    listener: null as null | (() => void),
    addEventListener(_type: string, listener: () => void) {
      this.listener = listener;
    },
  }));
  return {
    innerHTML: "",
    click(action: string) {
      buttons
        .find((button) => button.dataset.memoryAction === action)
        ?.listener?.();
    },
    querySelector(selector: string) {
      if (selector === "[data-memory-provider]") {
        return { value: providerValue };
      }
      if (selector === "[data-memory-model]") return { value: modelValue };
      if (selector === "[data-memory-events]") return { checked: false };
      return null;
    },
    querySelectorAll(selector: string) {
      return selector === "[data-memory-action]" ? buttons : [];
    },
    setFields(providerId: string, model: string) {
      providerValue = providerId;
      modelValue = model;
    },
  };
}

describe("long-term memory setup environment isolation", () => {
  test("ignores a stale status response after the environment changes", async () => {
    const devStatus = deferred<Record<string, unknown>>();
    const prodStatus = deferred<Record<string, unknown>>();
    let environmentId = "dev";
    const loadStatus = vi.fn((requestedEnvironmentId: string) =>
      requestedEnvironmentId === "dev" ? devStatus.promise : prodStatus.promise,
    );
    const setup = createLongTermMemorySetup({
      getEnvironmentId: () => environmentId,
      loadStatus,
      discoverModels: vi.fn(),
      enableMemory: vi.fn(),
      disableMemory: vi.fn(),
      recordControlEvent: vi.fn(),
    });
    const root = fakeRoot();
    setup.mount(root);

    const devLoad = setup.load();
    environmentId = "prod";
    const prodLoad = setup.load();
    prodStatus.resolve({
      status: {
        enabled: false,
        providerId: "prod-provider",
        providers: [{ id: "prod-provider", label: "Production" }],
      },
    });

    await expect(prodLoad).resolves.toBe(true);
    expect(root.innerHTML).toContain("prod-provider");
    expect(root.innerHTML).toContain("Disabled");

    devStatus.resolve({
      status: {
        enabled: true,
        providerId: "dev-provider",
        providers: [{ id: "dev-provider", label: "Development" }],
      },
    });
    await expect(devLoad).resolves.toBe(false);
    expect(root.innerHTML).toContain("prod-provider");
    expect(root.innerHTML).not.toContain("dev-provider");
    expect(root.innerHTML).toContain("Disabled");
  });

  test("resets the catalog and ignores an in-flight action from the previous environment", async () => {
    const staleDiscovery = deferred<Record<string, unknown>>();
    let environmentId = "dev";
    const discoverModels = vi
      .fn()
      .mockResolvedValueOnce({
        catalog: { supported: true, models: ["dev-seeded-model"] },
      })
      .mockReturnValueOnce(staleDiscovery.promise);
    const setup = createLongTermMemorySetup({
      getEnvironmentId: () => environmentId,
      loadStatus: vi.fn(async (requestedEnvironmentId: string) => ({
        status: {
          enabled: false,
          providerId: `${requestedEnvironmentId}-provider`,
          model: `${requestedEnvironmentId}-embedding`,
          providers: [
            {
              id: `${requestedEnvironmentId}-provider`,
              type: "ollama",
            },
          ],
        },
      })),
      discoverModels,
      enableMemory: vi.fn(),
      disableMemory: vi.fn(),
      recordControlEvent: vi.fn(),
    });
    const root = fakeInteractiveRoot();
    root.setFields("dev-provider", "dev-embedding");
    setup.mount(root);
    await setup.load();

    root.click("discover");
    await vi.waitFor(() =>
      expect(root.innerHTML).toContain("dev-seeded-model"),
    );
    root.click("discover");
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(2));

    environmentId = "prod";
    root.setFields("prod-provider", "prod-embedding");
    await setup.load();
    const prodMarkup = root.innerHTML;
    expect(prodMarkup).toContain("prod-provider");
    expect(prodMarkup).toContain("prod-embedding");
    expect(prodMarkup).not.toContain("dev-seeded-model");

    staleDiscovery.resolve({
      catalog: { supported: true, models: ["dev-late-model"] },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(root.innerHTML).toBe(prodMarkup);
    expect(root.innerHTML).not.toContain("dev-late-model");
    expect(discoverModels).toHaveBeenNthCalledWith(2, "dev-provider", "dev");
  });

  test("keeps Runtime mutation ownership until the canonical config refresh settles", async () => {
    const memoryUpdate = deferred<Record<string, unknown>>();
    const configRefresh = deferred<boolean>();
    const beginRuntimeMutation = vi.fn(() => true);
    const refreshRuntimeConfig = vi.fn(() => configRefresh.promise);
    const endRuntimeMutation = vi.fn();
    const enableMemory = vi.fn(() => memoryUpdate.promise);
    const recordControlEvent = vi.fn();
    const setup = createLongTermMemorySetup({
      getEnvironmentId: () => "dev",
      loadStatus: vi.fn(),
      discoverModels: vi.fn(),
      enableMemory,
      disableMemory: vi.fn(),
      recordControlEvent,
      beginRuntimeMutation,
      refreshRuntimeConfig,
      endRuntimeMutation,
    });
    const root = fakeInteractiveRoot();
    root.setFields("dev-provider", "dev-embedding");
    setup.mount(root);

    root.click("enable");
    await vi.waitFor(() => expect(enableMemory).toHaveBeenCalledOnce());
    expect(beginRuntimeMutation).toHaveBeenCalledOnce();
    expect(enableMemory).toHaveBeenCalledWith(
      {
        providerId: "dev-provider",
        model: "dev-embedding",
        emitClientEvents: false,
      },
      "dev",
    );

    memoryUpdate.resolve({
      status: {
        enabled: true,
        providerId: "dev-provider",
        model: "dev-embedding",
      },
    });
    await vi.waitFor(() => expect(refreshRuntimeConfig).toHaveBeenCalledOnce());
    expect(endRuntimeMutation).not.toHaveBeenCalled();

    configRefresh.resolve(true);
    await vi.waitFor(() => expect(endRuntimeMutation).toHaveBeenCalledOnce());
    expect(recordControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Long-term memory enabled" }),
    );
  });

  test("does not start a memory write when config state cannot be locked", async () => {
    const enableMemory = vi.fn();
    const setup = createLongTermMemorySetup({
      getEnvironmentId: () => "dev",
      loadStatus: vi.fn(),
      discoverModels: vi.fn(),
      enableMemory,
      disableMemory: vi.fn(),
      recordControlEvent: vi.fn(),
      beginRuntimeMutation: vi.fn(() => false),
      refreshRuntimeConfig: vi.fn(),
      endRuntimeMutation: vi.fn(),
    });
    const root = fakeInteractiveRoot();
    root.setFields("dev-provider", "dev-embedding");
    setup.mount(root);

    root.click("enable");
    await Promise.resolve();

    expect(enableMemory).not.toHaveBeenCalled();
    expect(root.innerHTML).toContain("Save or reset configuration changes");
  });
});
