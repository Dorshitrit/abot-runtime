import { expect, test, vi } from "vitest";
// @ts-expect-error Browser module.
import { createPluginInstallation } from "../../web-ui/app/components/plugins/installation.js";
// @ts-expect-error Browser module.
import { createPluginManager } from "../../web-ui/app/components/plugins/manager.js";
// @ts-expect-error Browser module.
import { renderPluginDiscovery } from "../../web-ui/app/components/plugins/discovery-rendering.js";
import {
  readWorkspaceRoute,
  workspaceRouteUrl,
} from "../../web-ui/app/lib/workspace-route.js";

const review = {
  source: {
    repository: "https://github.com/community/example",
    ref: "a".repeat(40),
  },
  digest: "b".repeat(64),
  id: "example",
  version: "1",
  description: "<script>bad</script>",
  capabilities: [],
  secrets: [],
};
function harness(overrides = {}) {
  let environment = "dev";
  const dependencies = {
    inspectPlugin: vi.fn(async () => ({ review })),
    installPlugin: vi.fn(async () => ({ plugins: [] })),
    getEnvironmentId: () => environment,
    beginRuntimeMutation: vi.fn(() => true),
    endRuntimeMutation: vi.fn(),
    refreshRuntimeConfig: vi.fn(async () => true),
    onConfigurationSaved: vi.fn(),
    onInstalled: vi.fn(),
    render: vi.fn(),
    ...overrides,
  };
  return {
    dependencies,
    controller: createPluginInstallation(dependencies),
    setEnvironment: (value: string) => {
      environment = value;
    },
  };
}
test("only local confirmation installs the exact reviewed bytes in the reviewed environment", async () => {
  const { controller, dependencies } = harness();
  expect(await controller.install()).toBe(false);
  await controller.inspect({ repository: review.source.repository });
  expect(dependencies.installPlugin).not.toHaveBeenCalled();
  expect(await controller.install()).toBe(true);
  expect(dependencies.installPlugin).toHaveBeenCalledWith(
    { source: review.source, digest: review.digest },
    "dev",
  );
  expect(dependencies.onConfigurationSaved).toHaveBeenCalledOnce();
  expect(dependencies.endRuntimeMutation).toHaveBeenCalledOnce();
});
test("unsaved configuration blocks installation and environment changes invalidate the review", async () => {
  const { controller, dependencies, setEnvironment } = harness({
    beginRuntimeMutation: () => false,
  });
  await controller.inspect(review.source);
  expect(await controller.install()).toBe(false);
  setEnvironment("production");
  expect(await controller.install()).toBe(false);
  expect(controller.state.review).toBeNull();
  expect(dependencies.installPlugin).not.toHaveBeenCalled();
});
test("an inspection response from another environment is ignored", async () => {
  let complete!: (value: unknown) => void;
  const { controller, setEnvironment } = harness({
    inspectPlugin: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const pending = controller.inspect(review.source);
  setEnvironment("production");
  controller.resetEnvironment();
  complete({ review });
  expect(await pending).toBe(false);
  expect(controller.state.review).toBeNull();
  expect(controller.state.busy).toBe(false);
});
test("website handoff opens Discover and reviews, but does not install", async () => {
  const inspectPlugin = vi.fn(async () => ({ review }));
  const installPlugin = vi.fn();
  const manager = createPluginManager({
    loadPlugins: async () => ({ plugins: [] }),
    inspectPlugin,
    installPlugin,
    getEnvironmentId: () => "dev",
  });
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  manager.mount(root);
  const route = readWorkspaceRoute(
    new URL(
      "http://localhost/plugins?environment=dev&pluginSource=" +
        encodeURIComponent(review.source.repository),
    ),
  );
  manager.openRoute(route);
  await Promise.resolve();
  expect(manager.activeTab()).toBe("discover");
  expect(inspectPlugin).toHaveBeenCalledWith(
    { repository: review.source.repository, ref: "", path: "" },
    "dev",
  );
  expect(installPlugin).not.toHaveBeenCalled();
  expect(root.innerHTML).toContain('role="tablist"');
  expect(workspaceRouteUrl({ ...route, tab: "discover" })).toBe(
    "/plugins?environment=dev&tab=discover",
  );
});
test("untrusted manifest content remains text in the review", () => {
  const html = renderPluginDiscovery({
    source: review.source,
    review,
    busy: false,
    error: "",
    message: "",
  });
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Install and enable");
});

test("Apply replaces installation's pending message", async () => {
  const { controller } = harness();
  await controller.inspect(review.source);
  await controller.install();
  controller.markApplied();
  expect(controller.state.message).toContain("applied");
  expect(controller.state.message).not.toContain("Apply changes");
});

test.each([0, 1])(
  "review confirmation button %s installs then opens Installed with feedback",
  async (index) => {
    const callbacks: Array<() => void> = [];
    const installPlugin = vi.fn(async () => ({ plugins: [] }));
    const buttons = [0, 1].map((i) => ({
      addEventListener: (_name: string, callback: () => void) => {
        callbacks[i] = callback;
      },
    }));
    const root = {
      innerHTML: "",
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === "[data-plugin-install-confirm]" ? buttons : [],
    };
    const manager = createPluginManager({
      loadPlugins: async () => ({ plugins: [] }),
      inspectPlugin: async () => ({ review }),
      installPlugin,
      getEnvironmentId: () => "dev",
      refreshRuntimeConfig: async () => true,
    });
    manager.mount(root);
    manager.openRoute({ pluginSource: review.source.repository });
    await vi.waitFor(() =>
      expect(root.innerHTML).toContain("Not installed yet."),
    );
    expect(root.innerHTML.match(/data-plugin-install-confirm/g)).toHaveLength(
      2,
    );
    expect(root.innerHTML).toContain('href="https://abot-ai.com/marketplace/"');
    callbacks[index]();
    await vi.waitFor(() => expect(manager.activeTab()).toBe("installed"));
    expect(installPlugin).toHaveBeenCalledOnce();
    expect(root.innerHTML).toContain("example installed. Apply changes");
  },
);

test("failed installation stays in Discover and keeps the review", async () => {
  let confirm!: () => void;
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: (selector: string) =>
      selector === "[data-plugin-install-confirm]"
        ? [
            {
              addEventListener: (_name: string, callback: () => void) => {
                confirm = callback;
              },
            },
          ]
        : [],
  };
  const manager = createPluginManager({
    loadPlugins: async () => ({ plugins: [] }),
    inspectPlugin: async () => ({ review }),
    installPlugin: async () => {
      throw new Error("download failed");
    },
  });
  manager.mount(root);
  manager.openRoute({ pluginSource: review.source.repository });
  await vi.waitFor(() =>
    expect(root.innerHTML).toContain("Not installed yet."),
  );
  confirm();
  await vi.waitFor(() => expect(root.innerHTML).toContain("download failed"));
  expect(manager.activeTab()).toBe("discover");
  expect(root.innerHTML).toContain("Not installed yet.");
});

test("successful install still reports a failed configuration refresh", async () => {
  const { controller } = harness({
    refreshRuntimeConfig: async () => {
      throw new Error("offline");
    },
  });
  await controller.inspect(review.source);
  await controller.install();
  expect(controller.state.installedPluginId).toBe("example");
  expect(controller.state.error).toBe(
    "Plugin installed; configuration refresh failed: offline",
  );
});
