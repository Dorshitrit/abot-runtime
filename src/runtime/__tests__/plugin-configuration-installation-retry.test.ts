import { expect, test, vi } from "vitest";
// @ts-expect-error Browser module.
import { createPluginInstallation } from "../../web-ui/app/components/plugins/installation.js";
// @ts-expect-error Browser module.
import { renderPluginConfigurationFields } from "../../web-ui/app/components/plugins/configuration-fields.js";

const defaults = {
  query: "default query",
  limit: 3,
  enabled: true,
  extra: { nested: true },
};

test.each([
  { name: "untouched defaults", saved: {}, submitted: {} },
  {
    name: "new edits and existing overrides",
    saved: { limit: 7 },
    submitted: { query: "edited query", limit: 7, enabled: false, extra: null },
  },
  { name: "explicit reset to defaults", saved: { limit: 7 }, submitted: {} },
])(
  "failed installation preserves $name through retry",
  async ({ saved, submitted }) => {
    const review = {
      id: "example",
      source: { repository: "https://github.com/example/plugin", ref: "main" },
      digest: "reviewed-digest",
      configuration: {
        revision: "reviewed-revision",
        defaults,
        settings: { ...defaults, ...saved },
        settingOverrides: Object.keys(saved),
        secrets: [{ name: "token", env: "TOKEN", configured: true }],
      },
    };
    const secret = { value: "one-shot-secret" };
    const settings: Record<string, unknown> = submitted;
    const controls = Object.fromEntries(
      Object.entries(defaults).map(([name, fallback], index) => {
        const overridden = Object.hasOwn(settings, name);
        const value = overridden ? settings[name] : fallback;
        return [
          `[data-plugin-setting="${index}"]`,
          {
            dataset: { pluginSettingOverridden: String(overridden) },
            value:
              typeof value === "object" ? JSON.stringify(value) : String(value),
            checked: value,
          },
        ];
      }),
    );
    const fields = {
      querySelector: (selector: string) => {
        if (selector === '[data-plugin-secret-action="0"]')
          return { value: "set" };
        if (selector === '[data-plugin-secret-value="0"]') return secret;
        return controls[selector];
      },
      querySelectorAll: () => [secret],
    };
    const installPlugin = vi
      .fn()
      .mockRejectedValueOnce(new Error("Installation failed"))
      .mockResolvedValueOnce({ plugins: [] });
    const rendered: { settings: unknown; overrides: string[]; html: string }[] =
      [];
    const endRuntimeMutation = vi.fn();
    const controller = createPluginInstallation({
      inspectPlugin: async () => ({ review }),
      installPlugin,
      getEnvironmentId: () => "dev",
      beginRuntimeMutation: () => true,
      endRuntimeMutation,
      refreshRuntimeConfig: async () => true,
      onConfigurationSaved: () => {},
      onInstalled: () => {},
      render: () => {
        const configuration = controller.state.review?.configuration;
        if (!configuration) return;
        rendered.push({
          settings: structuredClone(configuration.settings),
          overrides: [...configuration.settingOverrides],
          html: renderPluginConfigurationFields(
            configuration,
            controller.state.busy,
          ),
        });
      },
    });
    await controller.inspect(review.source);
    rendered.length = 0;

    expect(await controller.install(fields)).toBe(false);
    expect(controller.state.error).toBe("Installation failed");
    expect(controller.state.busy).toBe(false);
    expect(secret.value).toBe("");
    expect(JSON.stringify(controller.state)).not.toContain("one-shot-secret");
    // Both the busy render and the error render must retain effective values.
    expect(rendered).toHaveLength(2);
    for (const view of rendered) {
      expect(view.settings).toEqual({ ...defaults, ...submitted });
      expect(view.overrides).toEqual(Object.keys(submitted));
      expect(view.html).not.toContain("undefined");
      expect(view.html).not.toContain("one-shot-secret");
    }
    expect(installPlugin.mock.calls[0]).toEqual([
      {
        source: review.source,
        digest: review.digest,
        configuration: {
          revision: "reviewed-revision",
          settings: submitted,
          secrets: { token: { action: "set", value: "one-shot-secret" } },
        },
      },
      "dev",
    ]);

    // Retry from the retained review without more edits or re-entering the secret.
    expect(await controller.install()).toBe(true);
    expect(installPlugin.mock.calls[1]).toEqual([
      {
        source: review.source,
        digest: review.digest,
        configuration: {
          revision: "reviewed-revision",
          settings: submitted,
          secrets: {},
        },
      },
      "dev",
    ]);
    expect(endRuntimeMutation).toHaveBeenCalledTimes(2);
    expect(controller.state.review).toBeNull();
  },
);
