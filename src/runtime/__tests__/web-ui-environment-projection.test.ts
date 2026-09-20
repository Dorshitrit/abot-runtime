import { beforeEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition module has no declaration.
import * as environmentProjection from "../../web-ui/app/configuration-environment-refresh.js";
const { createAppliedEnvironmentProjection, createConfigurationFeature } =
  environmentProjection;
// @ts-expect-error Browser component has no declaration.
import { createRuntimeConfigActivation } from "../../web-ui/app/components/runtime-config-activation.js";

const composed = vi.hoisted(() => ({
  options: {} as Record<string, any>,
  load: vi.fn(async () => true),
}));
vi.mock("../../web-ui/app/configuration-feature.js", () => ({
  createConfigurationFeature: (options: Record<string, any>) => {
    composed.options = options;
    return { load: composed.load };
  },
}));

function config(ids: string[], defaultId = ids[0]) {
  return {
    defaultEnvironmentId: defaultId,
    environments: ids.map((id) => ({
      id,
      label: id,
      isDefault: id === defaultId,
    })),
  };
}

function harness() {
  const state = {
    config: config(["prod", "dev"]),
    messages: ["retained conversation"],
  };
  let values = ["prod", "dev"];
  let selected = "dev";
  let saved = "dev";
  let locked = false;
  let refused = false;
  const transitions: string[] = [];
  const environmentSelect = {
    ownerDocument: { defaultView: { Event } },
    get value() {
      return selected;
    },
    set value(value: string) {
      selected = values.includes(value) ? value : "";
    },
    dispatchEvent() {
      if (selected === saved) return true;
      if (locked || refused) {
        this.value = saved;
        return true;
      }
      saved = selected;
      transitions.push(selected);
      state.messages = [];
      return true;
    },
  };
  const dom = { environmentSelect };
  const selection = {
    selectedEnvironmentId: () => selected,
    renderEnvironmentOptions: () => {
      values = state.config.environments.map(({ id }) => id);
      if (!values.includes(selected)) selected = values[0] || "";
    },
    environmentOptions: () => values.map((value) => ({ value })),
    renderAgentPicker: vi.fn(),
  };
  const loadWebConfig = vi.fn(async () => config(["prod", "qa"], "qa"));
  const projection = createAppliedEnvironmentProjection({
    state,
    dom,
    selection,
    loadWebConfig,
  });
  return {
    state,
    dom,
    selection,
    projection,
    loadWebConfig,
    transitions,
    lock: (value: boolean) => {
      locked = value;
    },
    refuse: (value: boolean) => {
      refused = value;
    },
  };
}

function activation(
  h: ReturnType<typeof harness>,
  apply: () => Promise<unknown>,
) {
  let click = async () => {};
  const status = { textContent: "" };
  const button = {
    disabled: false,
    addEventListener: (_: string, handler: () => Promise<void>) => {
      click = handler;
    },
  };
  const panel = {
    innerHTML: "",
    className: "",
    setAttribute: vi.fn(),
    querySelector: (name: string) => (name === "p" ? status : button),
  };
  createRuntimeConfigActivation({
    root: { ownerDocument: { createElement: () => panel }, prepend: vi.fn() },
    apply,
    refresh: composed.options.onConfigurationApplied,
    onAppliedSettled: composed.options.onConfigurationSettled,
    getEnvironmentId: h.selection.selectedEnvironmentId,
    getWorkspace: () => ({
      beginExternalRuntimeMutation: () => {
        h.lock(true);
        return true;
      },
      endExternalRuntimeMutation: () => {
        h.lock(false);
      },
    }),
  });
  return { click: () => click(), status };
}

function feature(h: ReturnType<typeof harness>) {
  const reloadModels = vi.fn(async () => true);
  const workspace = createConfigurationFeature({
    state: h.state,
    dom: h.dom,
    selection: h.selection,
    runtimeClient: { loadWebConfig: h.loadWebConfig },
    onConfigurationApplied: reloadModels,
  });
  return { workspace, reloadModels };
}

beforeEach(() => {
  composed.load.mockClear();
});

describe("applied environment projection", () => {
  test("replaces a removed selection only after Apply releases the mutation guard", async () => {
    const h = harness();
    const { reloadModels } = feature(h);
    const controller = activation(h, async () => ({
      activation: { status: "ready" },
    }));
    await controller.click();
    expect(h.state.config).toEqual(config(["prod", "qa"], "qa"));
    expect(h.dom.environmentSelect.value).toBe("qa");
    expect(h.transitions).toEqual(["qa"]);
    expect(h.state.messages).toEqual([]);
    expect(reloadModels).not.toHaveBeenCalled(); // Normal environment navigation owns its loads.
    expect(controller.status.textContent).toContain("now active");
  });

  test("retains a still-configured selection and conversation despite a new default", async () => {
    const h = harness();
    h.loadWebConfig.mockResolvedValue(config(["prod", "dev", "qa"], "qa"));
    const { reloadModels } = feature(h);
    await activation(h, async () => ({
      activation: { status: "ready" },
    })).click();
    expect(h.dom.environmentSelect.value).toBe("dev");
    expect(h.transitions).toEqual([]);
    expect(h.state.messages).toEqual(["retained conversation"]);
    expect(reloadModels).toHaveBeenCalledOnce();
  });

  test.each(["restart_required", "failure"])(
    "does not update metadata when Apply reports %s",
    async (status) => {
      const h = harness();
      feature(h);
      await activation(h, async () => {
        if (status === "failure") throw new Error("apply failed");
        return { activation: { status } };
      }).click();
      expect(h.loadWebConfig).not.toHaveBeenCalled();
      expect(h.state.config).toEqual(config(["prod", "dev"]));
      expect(h.dom.environmentSelect.value).toBe("dev");
    },
  );

  test("staging metadata cannot change picker or conversation under a lock", async () => {
    const h = harness();
    const original = h.state.config;
    h.lock(true);
    await h.projection.prepare();
    expect(h.state.config).toBe(original);
    expect(h.transitions).toEqual([]);
    h.lock(false);
    expect(h.projection.flush()).toBe("changed");
    expect(h.transitions).toEqual(["qa"]);
  });

  test("navigation refusal restores previous options and retains the draft scope", async () => {
    const h = harness();
    h.refuse(true);
    await h.projection.prepare();
    expect(h.projection.flush()).toBe("blocked");
    expect(h.dom.environmentSelect.value).toBe("dev");
    expect(h.state.config).toEqual(config(["prod", "dev"]));
    expect(h.state.messages).toEqual(["retained conversation"]);
    h.refuse(false);
    expect(h.projection.flush()).toBe("changed");
    expect(h.transitions).toEqual(["qa"]);
  });

  test("failed newer refresh cannot flush a previously blocked metadata snapshot", async () => {
    const h = harness();
    h.refuse(true);
    await h.projection.prepare();
    expect(h.projection.flush()).toBe("blocked");
    h.loadWebConfig.mockRejectedValueOnce(new Error("refresh failed"));
    await expect(h.projection.prepare()).rejects.toThrow("refresh failed");
    h.refuse(false);
    expect(h.projection.flush()).toBe("unchanged");
    expect(h.state.config).toEqual(config(["prod", "dev"]));
    expect(h.transitions).toEqual([]);
  });

  test("late metadata response cannot overwrite a newer projection", async () => {
    const h = harness();
    let finish!: (value: ReturnType<typeof config>) => void;
    h.loadWebConfig.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = h.projection.prepare();
    h.loadWebConfig.mockResolvedValueOnce(config(["prod", "new"], "new"));
    await h.projection.prepare();
    finish(config(["prod", "old"], "old"));
    await first;
    h.projection.flush();
    expect(h.dom.environmentSelect.value).toBe("new");
  });

  test("onboarding refresh updates the initial Configuration snapshot as well as models", async () => {
    const h = harness();
    h.loadWebConfig.mockResolvedValue(config(["prod", "dev"]));
    const { workspace, reloadModels } = feature(h);
    expect(await workspace.reloadAppliedEnvironmentModels()).toBe(true);
    expect(composed.load).toHaveBeenCalledOnce();
    expect(reloadModels).toHaveBeenCalledOnce();
    expect(h.transitions).toEqual([]);
  });
});
