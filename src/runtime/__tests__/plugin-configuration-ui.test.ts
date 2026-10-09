import { expect, test, vi } from "vitest";
import {
  renderPluginConfigurationFields,
  readPluginConfigurationFields,
  clearPluginSecretInputs,
  // @ts-expect-error Browser module.
} from "../../web-ui/app/components/plugins/configuration-fields.js";
// @ts-expect-error Browser module.
import { createPluginInstallation } from "../../web-ui/app/components/plugins/installation.js";
// @ts-expect-error Browser module.
import { createPluginConfigurationDraft } from "../../web-ui/app/components/plugins/configuration-draft.js";
// @ts-expect-error Browser module.
import { createPluginConfigurationRequests } from "../../web-ui/app/services/runtime-web-client/plugin-configuration.js";

const configuration = {
  pluginId: "example",
  revision: "revision",
  settingOverrides: ["query", "limit", "enabled", "extra"],
  defaults: { query: "", limit: 3, enabled: true, extra: null },
  settings: {
    query: '<img src="x" onerror="bad">',
    limit: 4,
    enabled: false,
    extra: { nested: true },
  },
  secrets: [{ name: "token", env: "TOKEN", required: true, configured: true }],
};
function fields() {
  const controls: Record<string, any> = {
    '[data-plugin-setting="0"]': { value: "custom query" },
    '[data-plugin-setting="1"]': { value: "7" },
    '[data-plugin-setting="2"]': { checked: false },
    '[data-plugin-setting="3"]': { value: '{"nested":true}' },
    '[data-plugin-secret-action="0"]': { value: "set" },
    '[data-plugin-secret-value="0"]': { value: "entered-private-token" },
  };
  return {
    controls,
    root: {
      querySelector: (key: string) => controls[key],
      querySelectorAll: () => [controls['[data-plugin-secret-value="0"]']],
    },
  };
}

test("form infers existing defaults, escapes values and never populates password attributes", () => {
  const html = renderPluginConfigurationFields(configuration);
  expect(html).toContain('type="number"');
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("<textarea");
  expect(html).not.toContain("<img");
  expect(html.match(/<input type="password"[^>]*>/u)?.[0]).not.toContain(
    " value=",
  );
});

test("one outbound payload carries typed settings and explicit secret actions", () => {
  const { root, controls } = fields();
  const payload = readPluginConfigurationFields(root, configuration);
  expect(payload).toEqual({
    revision: "revision",
    settings: {
      query: "custom query",
      limit: 7,
      enabled: false,
      extra: { nested: true },
    },
    secrets: { token: { action: "set", value: "entered-private-token" } },
  });
  controls['[data-plugin-secret-action="0"]'].value = "keep";
  expect(readPluginConfigurationFields(root, configuration).secrets).toEqual(
    {},
  );
  controls['[data-plugin-secret-action="0"]'].value = "clear";
  expect(readPluginConfigurationFields(root, configuration).secrets).toEqual({
    token: { action: "clear" },
  });
  clearPluginSecretInputs(root);
  expect(controls['[data-plugin-secret-value="0"]'].value).toBe("");
});

test("invalid numbers and missing required installation secrets are caught before transport", () => {
  const { root, controls } = fields();
  controls['[data-plugin-setting="1"]'].value = "";
  expect(() => readPluginConfigurationFields(root, configuration)).toThrow(
    "Enter a number",
  );
  controls['[data-plugin-setting="1"]'].value = "7";
  controls['[data-plugin-secret-action="0"]'].value = "clear";
  expect(() =>
    readPluginConfigurationFields(root, configuration, true),
  ).toThrow("Configure token");
});

test("installation sends configuration once without persisting secrets in controller state", async () => {
  const { root, controls } = fields();
  const review = {
    id: "example",
    source: {
      repository: "https://github.com/example/plugin",
      ref: "a".repeat(40),
    },
    digest: "b".repeat(64),
    configuration: structuredClone(configuration),
  };
  const installPlugin = vi.fn(
    async (_input: unknown, _environment: string) => ({ plugins: [] }),
  );
  const controller = createPluginInstallation({
    inspectPlugin: async () => ({ review }),
    installPlugin,
    getEnvironmentId: () => "dev",
    beginRuntimeMutation: () => true,
    endRuntimeMutation: () => {},
    refreshRuntimeConfig: async () => true,
    onConfigurationSaved: () => {},
    onInstalled: () => {},
    render: () => {},
  });
  await controller.inspect(review.source);
  expect(await controller.install(root)).toBe(true);
  expect(installPlugin.mock.calls[0]?.[0]).toMatchObject({
    configuration: {
      settings: { query: "custom query" },
      secrets: { token: { value: "entered-private-token" } },
    },
  });
  expect(JSON.stringify(controller.state)).not.toContain(
    "entered-private-token",
  );
  expect(controls['[data-plugin-secret-value="0"]'].value).toBe("");
});

test("draft restoration moves existing controls without serializing passwords, and invalidation clears them", () => {
  const { root: fieldRoot, controls } = fields();
  const draft = createPluginConfigurationDraft();
  let mounted: any = fieldRoot;
  const root = { querySelector: () => mounted };
  const review = {};
  draft.restore(root, review, false);
  draft.capture(root, review, false);
  mounted = {
    replaceWith: (node: unknown) => {
      mounted = node;
    },
  };
  draft.restore(root, review, false);
  expect(mounted).toBe(fieldRoot);
  expect(controls['[data-plugin-secret-value="0"]'].value).toBe(
    "entered-private-token",
  );
  draft.capture(root, {}, false);
  expect(controls['[data-plugin-secret-value="0"]'].value).toBe("");
});

test.each(["repository", "ref", "path"])(
  "editing %s clears the review's secret and releases its draft before detaching controls",
  async (changedField) => {
    const secret = { value: "unsaved-private-token" };
    const inputListeners = new Map<string, () => void>();
    const fields = {
      addEventListener: (name: string, listener: () => void) => {
        inputListeners.set(name, listener);
      },
      querySelectorAll: (selector: string) =>
        selector === "[data-plugin-secret-value]" ? [secret] : [],
      replaceWith: vi.fn(),
    };
    let mounted: typeof fields | null = fields;
    const formListeners = new Map<string, () => void>();
    const form = {
      elements: {
        repository: { value: "https://github.com/example/plugin" },
        ref: { value: "main" },
        path: { value: "plugin" },
      } as Record<string, { value: string }>,
      addEventListener: (name: string, listener: () => void) => {
        formListeners.set(name, listener);
      },
    };
    const remove = vi.fn(() => {
      expect(secret.value).toBe("");
      mounted = null;
    });
    const root = {
      querySelector: (selector: string): unknown => {
        if (selector === "[data-plugin-source-form]") return form;
        if (selector === "[data-plugin-configuration-fields]") return mounted;
        if (selector === ".plugin-install-review") return { remove };
        return null;
      },
      querySelectorAll: () => [],
    };
    const review = { id: "example", configuration };
    const render = vi.fn();
    const installPlugin = vi.fn();
    const controller = createPluginInstallation({
      inspectPlugin: async () => ({ review }),
      installPlugin,
      getEnvironmentId: () => "dev",
      render,
    });
    await controller.inspect();
    controller.bind(root);
    inputListeners.get("input")!();
    expect(controller.state.dirty).toBe(true);
    render.mockClear();

    form.elements[changedField]!.value += "-changed";
    formListeners.get("input")!();

    expect(remove).toHaveBeenCalledOnce();
    expect(controller.state.review).toBeNull();
    expect(controller.state.dirty).toBe(false);
    expect(controller.state.source[changedField]).toBe(
      form.elements[changedField]!.value,
    );
    expect(render).not.toHaveBeenCalled();
    expect(await controller.install()).toBe(false);
    expect(installPlugin).not.toHaveBeenCalled();

    // Even reuse of the same review object cannot restore discarded controls.
    const replacement = { ...fields, replaceWith: vi.fn() };
    mounted = replacement;
    await controller.inspect();
    controller.bind(root);
    expect(replacement.replaceWith).not.toHaveBeenCalled();
  },
);

test("configuration credentials remain in the PUT body and never in the request URL", () => {
  const requestApi = vi.fn();
  const requests = createPluginConfigurationRequests({
    requestApi,
    environmentQuery: (value: string) => encodeURIComponent(value),
  });
  requests.savePluginConfiguration(
    "example",
    { secrets: { token: { action: "set", value: "private-value" } } },
    "dev",
  );
  expect(requestApi.mock.calls[0]?.[0]).toBe(
    "/runtime/plugins/configuration/example?environment=dev",
  );
  expect(requestApi.mock.calls[0]?.[1].body).toContain("private-value");
});
