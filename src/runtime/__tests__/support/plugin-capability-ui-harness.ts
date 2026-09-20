import { vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createPluginManager } from "../../../web-ui/app/components/plugins/manager.js";

export type CapabilitySelectionInput = {
  pluginId: string;
  enabled: boolean;
  capabilityId?: string;
};
export type CapabilityRow = {
  id: string;
  description: string;
  enabled: boolean;
  blockedByPolicy: boolean;
  blockedReason?: string;
};
export const capabilitySnapshot = {
  selection: { enabled: true, allow: ["*"], deny: [] as string[] },
  plugins: [
    {
      id: "filesystem",
      description: "Workspace files",
      pluginEnabled: true,
      capabilityCount: 2,
      selectedCapabilityCount: 2,
      state: "enabled",
      blockedByGlobalPolicy: false,
      capabilities: [
        {
          id: "read_file",
          description: "Read a file.",
          enabled: true,
          blockedByPolicy: false,
        },
        {
          id: "write_file",
          description: "Write a file.",
          enabled: true,
          blockedByPolicy: false,
        },
      ] as CapabilityRow[],
    },
  ],
  application: "restart_required",
};

type ControlEvent = { key?: string; preventDefault: () => void; stopPropagation: () => void };

type Control = {
  dataset: Record<string, string>;
  disabled: boolean;
  checked: boolean;
  hidden: boolean;
  inert: boolean;
  scrollTop: number;
  addEventListener: (event: string, listener: (detail?: ControlEvent) => unknown) => void;
  dispatch: (event: string, detail?: ControlEvent) => unknown;
  focus: () => void;
  closest: (selector: string) => unknown;
};

export function pluginCapabilityHarness(
  options: {
    snapshot?: typeof capabilitySnapshot;
    refresh?: () => Promise<boolean>;
    setPlugin?: (
      input: CapabilitySelectionInput,
    ) => Promise<typeof capabilitySnapshot>;
  } = {},
) {
  let snapshot = structuredClone(options.snapshot || capabilitySnapshot);
  const body = {};
  const document = { body, activeElement: body as object };
  const viewport = { scrollTop: 280, isConnected: true, inert: false };

  function createRoot() {
    let html = "";
    let controls: Control[] = [];
    const root = {
      isConnected: true,
      ownerDocument: document,
      closest: (selector: string) =>
        selector === ".config-workspace-body" ? viewport : null,
      contains: (control: unknown) => controls.includes(control as Control),
      get innerHTML() {
        return html;
      },
      set innerHTML(value: string) {
        if (controls.includes(document.activeElement as Control))
          document.activeElement = body;
        html = value;
        controls = [
          ...html.matchAll(/<(?:button|input|section|div|ul)\b([^>]*)>/gu),
        ].map((match) => {
          const attributes = match[1] || "";
          const dataset = Object.fromEntries(
            [...attributes.matchAll(/data-([a-z-]+)(?:="([^"]*)")?/gu)].map(
              (attribute) => [
                attribute[1]!.replace(/-([a-z])/gu, (_all, letter: string) =>
                  letter.toUpperCase(),
                ),
                attribute[2] || "",
              ],
            ),
          );
          const listeners = new Map<string, (detail?: ControlEvent) => unknown>();
          const pluginId = dataset.pluginParent || dataset.pluginToolsBack || dataset.pluginToolsScroll || dataset.pluginToolsPanel;
          const panel = [...html.matchAll(/<section\b[^>]*data-plugin-tools-panel="([^"]+)"([^>]*)>/gu)].find((entry) => entry[1] === pluginId)?.[2] || "";
          const frontId = dataset.pluginToggle || dataset.pluginToolsOpen || dataset.pluginCardFront;
          const front = [...html.matchAll(/<div\b[^>]*data-plugin-card-front="([^"]+)"([^>]*)>/gu)].find((entry) => entry[1] === frontId)?.[2] || "";
          const control: Control = {
            dataset,
            disabled: /(?:^|\s)disabled(?:\s|$)/u.test(attributes),
            checked: /(?:^|\s)checked(?:\s|\/|$)/u.test(attributes),
            hidden: /(?:^|\s)hidden(?:\s|$)/u.test(panel),
            inert: /(?:^|\s)inert(?:\s|$)/u.test(front),
            scrollTop: 0,
            addEventListener: (event, listener) => {
              listeners.set(event, listener);
            },
            dispatch: (event, detail) => {
              if (control.disabled || control.hidden || control.inert) return;
              return listeners.get(event)?.(detail);
            },
            focus: vi.fn(() => {
              if (!control.disabled && !control.hidden && !control.inert && !viewport.inert)
                document.activeElement = control;
            }),
            closest: (selector) => {
              if (selector === "[hidden]" && control.hidden) return control;
              if (selector === "[inert]" && (viewport.inert || control.inert)) return viewport;
              return null;
            },
          };
          return control;
        });
      },
      querySelectorAll(selector: string) {
        return controls.filter((control) =>
          selector.split(", ").some((part) => {
            const key = part
              .match(/\[data-([a-z-]+)\]/u)?.[1]
              ?.replace(/-([a-z])/gu, (_all, letter: string) =>
                letter.toUpperCase(),
              );
            return key !== undefined && Object.hasOwn(control.dataset, key);
          }),
        );
      },
      querySelector(selector: string) {
        return root.querySelectorAll(selector)[0] || null;
      },
    };
    return root;
  }

  let root = createRoot();
  const dependencies = {
    loadPlugins: vi.fn(async () => snapshot),
    setPlugin: vi.fn(async (input: CapabilitySelectionInput) => {
      if (options.setPlugin) return options.setPlugin(input);
      snapshot = {
        ...snapshot,
        plugins: snapshot.plugins.map((plugin) => {
          if (plugin.id !== input.pluginId) return plugin;
          const capabilities = plugin.capabilities.map((capability) =>
            capability.id === input.capabilityId
              ? { ...capability, enabled: input.enabled }
              : capability,
          );
          const count = capabilities.filter(
            (capability) => capability.enabled,
          ).length;
          return {
            ...plugin,
            capabilities,
            selectedCapabilityCount: count,
            state: count === 0 ? "disabled" : "partial",
          };
        }),
      };
      return snapshot;
    }),
    beginRuntimeMutation: vi.fn(() => true),
    refreshRuntimeConfig: vi.fn(options.refresh || (async () => true)),
    endRuntimeMutation: vi.fn(),
    onConfigurationSaved: vi.fn(),
    recordControlEvent: vi.fn(),
  };
  const manager = createPluginManager(dependencies);
  manager.mount(root);
  const capabilityControl = (id: string) =>
    root
      .querySelectorAll("[data-plugin-capability-toggle]")
      .find((control) => control.dataset.pluginCapabilityToggle === id)!;
  return {
    manager,
    dependencies,
    viewport,
    document,
    get root() {
      return root;
    },
    get snapshot() {
      return snapshot;
    },
    capabilityControl,
    toolsPanel: () => root.querySelector("[data-plugin-tools-panel]")!,
    toolsList: () => root.querySelector("[data-plugin-tools-scroll]")!,
    front: () => root.querySelector("[data-plugin-card-front]")!,
    opener: () => root.querySelector("[data-plugin-tools-open]")!,
    back: () => root.querySelector("[data-plugin-tools-back]")!,
    openTools: () => {
      const opener = root.querySelector("[data-plugin-tools-open]")!;
      opener.focus();
      opener.dispatch("click");
    },
    closeTools: () => {
      const back = root.querySelector("[data-plugin-tools-back]")!;
      back.focus();
      back.dispatch("click");
    },
    escapeTools: () => {
      const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
      root.querySelector("[data-plugin-tools-panel]")!.dispatch("keydown", event);
      return event;
    },
    async changeCapability(id: string, enabled: boolean) {
      const control = capabilityControl(id);
      control.focus();
      control.checked = enabled;
      await control.dispatch("change");
    },
    remount() {
      root.isConnected = false;
      for (const list of root.querySelectorAll("[data-plugin-tools-scroll]")) list.scrollTop = 0;
      document.activeElement = body;
      root = createRoot();
      manager.mount(root);
    },
  };
}
