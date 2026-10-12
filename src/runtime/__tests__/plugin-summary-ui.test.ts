import { describe, expect, test, vi } from "vitest";
import type { RuntimePluginSnapshot } from "../../web-ui/plugin-management-catalog.js";

// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createPluginManager } from "../../web-ui/app/components/plugins/manager.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { projectPluginSummary } from "../../web-ui/app/components/plugins/summary.js";

type Summary = {
  label: string;
  items: { label: string; value: string; status?: boolean; dirty?: boolean }[];
};

function snapshot(): RuntimePluginSnapshot {
  return {
    selection: {
      enabled: true,
      allow: ["*"],
      deny: ["partial:write", "empty:*", "off"],
      disabledPluginIds: [],
    },
    application: "restart_required",
    plugins: [
      {
        id: "partial",
        compatibility: {
          supported: true,
          status: "legacy",
          runtimePlatform: "linux",
        },
        pluginEnabled: true,
        removable: true,
        configurable: false,
        capabilities: [
          {
            id: "read",
            description: "Read",
            enabled: true,
            blockedByPolicy: false,
          },
          {
            id: "write",
            description: "Write",
            enabled: false,
            blockedByPolicy: false,
          },
        ],
        capabilityCount: 2,
        selectedCapabilityCount: 1,
        state: "partial",
        blockedByGlobalPolicy: false,
      },
      {
        id: "empty",
        compatibility: {
          supported: true,
          status: "legacy",
          runtimePlatform: "linux",
        },
        pluginEnabled: true,
        removable: true,
        configurable: false,
        capabilities: ["one", "two", "three"].map((id) => ({
          id,
          description: id,
          enabled: false,
          blockedByPolicy: false,
        })),
        capabilityCount: 3,
        selectedCapabilityCount: 0,
        state: "disabled",
        blockedByGlobalPolicy: false,
      },
      {
        id: "off",
        compatibility: {
          supported: true,
          status: "legacy",
          runtimePlatform: "linux",
        },
        pluginEnabled: false,
        removable: true,
        configurable: false,
        capabilities: [
          {
            id: "read",
            description: "Read",
            enabled: false,
            blockedByPolicy: false,
          },
        ],
        capabilityCount: 1,
        selectedCapabilityCount: 0,
        state: "disabled",
        blockedByGlobalPolicy: false,
      },
    ],
  };
}

function values(summary: Summary) {
  return summary.items.map((item) => item.value);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(overrides: Record<string, unknown> = {}) {
  const notifications: Summary[] = [];
  const dependencies = {
    loadPlugins: vi.fn(async () => snapshot()),
    setPlugin: vi.fn(async () => snapshot()),
    refreshRuntimeConfig: vi.fn(async () => true),
    getEnvironmentId: () => "dev",
    onSummaryChange: () => notifications.push(manager.summary()),
    ...overrides,
  };
  const manager = createPluginManager(dependencies);
  return { manager, dependencies, notifications };
}

describe("plugin saved configuration summary", () => {
  test("counts parent selection separately from child selection without claiming Runtime status", () => {
    const result = projectPluginSummary(
      { snapshot: snapshot(), environmentId: "dev", busy: false, error: "" },
      "dev",
    );
    expect(result).toEqual({
      label: "Plugins · saved configuration",
      items: [
        { label: "Installed plugins", value: "3" },
        { label: "Enabled in saved config", value: "2" },
        { label: "Selected tools (saved)", value: "1 / 6" },
        { label: "Excluded tools (saved)", value: "5" },
      ],
    });
  });

  test("an empty installed catalog is a loaded zero count", () => {
    const result = projectPluginSummary(
      { snapshot: { ...snapshot(), plugins: [] }, environmentId: "dev" },
      "dev",
    );
    expect(values(result)).toEqual(["0", "0", "0 / 0", "0"]);
    expect(
      result.items.every((item: Summary["items"][number]) => !item.status),
    ).toBe(true);
  });

  test("missing, loading, failed and stale data are not reported as zero", () => {
    for (const [state, expected] of [
      [{ snapshot: null, environmentId: "dev" }, "Not loaded"],
      [{ snapshot: null, environmentId: "dev", busy: true }, "Loading…"],
      [
        { snapshot: null, environmentId: "dev", error: "offline" },
        "Unavailable",
      ],
      [
        { snapshot: snapshot(), environmentId: "prod", busy: true },
        "Not loaded",
      ],
    ] as const) {
      const result = projectPluginSummary(state, "dev");
      expect(values(result)).toEqual(Array(4).fill(expected));
      expect(
        result.items.every((item: Summary["items"][number]) => item.status),
      ).toBe(true);
    }
  });

  test("load notifies summary consumers even before a root is mounted", async () => {
    const loading = deferred<RuntimePluginSnapshot>();
    const { manager, dependencies, notifications } = harness({
      loadPlugins: vi.fn(() => loading.promise),
    });
    expect(values(manager.summary())).toEqual(Array(4).fill("Not loaded"));
    const pending = manager.load();
    expect(values(notifications.at(-1)!)).toEqual(Array(4).fill("Loading…"));
    loading.resolve(snapshot());
    expect(await pending).toBe(true);
    expect(values(notifications.at(-1)!)).toEqual(["3", "2", "1 / 6", "5"]);
    expect(dependencies.loadPlugins).toHaveBeenCalledOnce();
  });

  test("a failed catalog reload invalidates previous counts", async () => {
    const { manager, dependencies } = harness();
    await manager.load();
    dependencies.loadPlugins.mockRejectedValueOnce(new Error("offline"));
    expect(await manager.load()).toBe(false);
    expect(values(manager.summary())).toEqual(Array(4).fill("Unavailable"));
  });

  test("saved capability selection updates summary without another catalog request", async () => {
    const saving = deferred<RuntimePluginSnapshot>();
    const { manager, dependencies, notifications } = harness({
      setPlugin: vi.fn(() => saving.promise),
    });
    await manager.load();
    const pending = manager.toggleCapability("partial", "write", true);
    expect(values(manager.summary())).toEqual(Array(4).fill("Loading…"));
    const saved = snapshot();
    saved.plugins[0]!.selectedCapabilityCount = 2;
    saved.plugins[0]!.state = "enabled";
    saved.plugins[0]!.capabilities[1]!.enabled = true;
    saving.resolve(saved);
    expect(await pending).toBe(true);
    expect(values(notifications.at(-1)!)).toEqual(["3", "2", "2 / 6", "4"]);
    expect(dependencies.loadPlugins).toHaveBeenCalledOnce();
    expect(dependencies.setPlugin).toHaveBeenCalledWith({
      pluginId: "partial",
      capabilityId: "write",
      enabled: true,
    });
  });

  test("failed selection saves retain the last valid saved counts", async () => {
    const { manager } = harness({
      setPlugin: vi.fn(async () => {
        throw new Error("write failed");
      }),
    });
    await manager.load();
    expect(await manager.toggle("partial", false)).toBe(false);
    expect(values(manager.summary())).toEqual(["3", "2", "1 / 6", "5"]);
  });

  test("removal callbacks refresh the summary without a mounted root", async () => {
    const removed = {
      ...snapshot(),
      plugins: [],
      removed: true,
      message: "Removed",
    };
    const { manager, notifications } = harness({
      removePlugin: vi.fn(async () => removed),
      confirmRemoval: () => true,
    });
    await manager.load();
    expect(await manager.remove("partial")).toBe(true);
    expect(values(notifications.at(-1)!)).toEqual(["0", "0", "0 / 0", "0"]);
  });

  test("environment changes hide previous counts and reject stale responses", async () => {
    let environmentId = "dev";
    const oldLoad = deferred<RuntimePluginSnapshot>();
    const newLoad = deferred<RuntimePluginSnapshot>();
    const { manager } = harness({
      getEnvironmentId: () => environmentId,
      loadPlugins: vi
        .fn()
        .mockReturnValueOnce(oldLoad.promise)
        .mockReturnValueOnce(newLoad.promise),
    });
    const first = manager.load();
    environmentId = "prod";
    expect(values(manager.summary())).toEqual(Array(4).fill("Not loaded"));
    const second = manager.load();
    newLoad.resolve({ ...snapshot(), plugins: [] });
    await second;
    oldLoad.resolve(snapshot());
    expect(await first).toBe(false);
    expect(values(manager.summary())).toEqual(["0", "0", "0 / 0", "0"]);
  });

  test("a stale rootless installation inspection cannot keep the new environment loading", async () => {
    let environmentId = "dev";
    const inspection = deferred<unknown>();
    const { manager } = harness({
      getEnvironmentId: () => environmentId,
      inspectPlugin: vi.fn(() => inspection.promise),
    });
    await manager.load();
    manager.openRoute({ pluginSource: "https://example.com/plugin" });
    expect(values(manager.summary())).toEqual(Array(4).fill("Loading…"));
    environmentId = "prod";
    await manager.load();
    expect(values(manager.summary())).toEqual(["3", "2", "1 / 6", "5"]);
    inspection.resolve({ review: { id: "stale" } });
    await inspection.promise;
    expect(values(manager.summary())).toEqual(["3", "2", "1 / 6", "5"]);
  });
});
