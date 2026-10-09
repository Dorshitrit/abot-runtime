import { expect, test, vi } from "vitest";
import {
  renderPluginSettings,
  bindPluginSettingFields,
  readPluginSettingOverrides,
  // @ts-expect-error Browser module.
} from "../../web-ui/app/components/plugins/configuration-settings.js";

function settingControls(
  fallback: unknown,
  saved: unknown = fallback,
  overridden = false,
) {
  const listeners = new Map<string, () => void>();
  const input = {
    dataset: {
      pluginSetting: "0",
      pluginSettingOverridden: String(overridden),
    },
    value: typeof saved === "object" ? JSON.stringify(saved) : String(saved),
    checked: Boolean(saved),
    addEventListener: (name: string, listener: () => void) =>
      listeners.set(name, listener),
  };
  const button = {
    dataset: {
      pluginSettingDefault: "0",
      pluginSettingDefaultValue: JSON.stringify(fallback),
    },
    addEventListener: (name: string, listener: () => void) =>
      listeners.set(name, listener),
  };
  const status = { textContent: overridden ? "Local value" : "Plugin default" };
  const root = {
    querySelectorAll: (selector: string) =>
      selector === "[data-plugin-setting]" ? [input] : [button],
    querySelector: (selector: string) =>
      selector === '[data-plugin-setting="0"]' ? input : status,
  };
  const configuration = {
    defaults: { value: fallback },
    settings: { value: saved },
    settingOverrides: overridden ? ["value"] : [],
  };
  const changed = vi.fn();
  bindPluginSettingFields(root, changed);
  return {
    root,
    configuration,
    input,
    status,
    changed,
    edit: () => listeners.get("input")!(),
    reset: () => listeners.get("click")!(),
  };
}

test.each(["text", 3, true, { a: [1] }, [1, 2], null])(
  "untouched %j stays inherited; editing and explicit reset update only its override",
  (fallback) => {
    const f = settingControls(fallback);
    expect(readPluginSettingOverrides(f.root, f.configuration)).toEqual({});
    f.reset();
    expect(f.changed).not.toHaveBeenCalled();
    // An intentional edit can pin a value even when it equals today's default.
    f.edit();
    expect(readPluginSettingOverrides(f.root, f.configuration)).toEqual({
      value: fallback,
    });
    expect(f.status.textContent).toBe("Local value");
    f.reset();
    expect(readPluginSettingOverrides(f.root, f.configuration)).toEqual({});
    expect(f.status.textContent).toBe("Plugin default");
    expect(f.changed).toHaveBeenCalledOnce();
    f.reset();
    expect(f.changed).toHaveBeenCalledOnce();
  },
);

test.each([
  ["default", "custom"],
  [3, 9],
  [false, true],
  [{ a: 1 }, { b: 2 }],
  [[1], [2]],
  [null, { a: 1 }],
])(
  "explicit reset restores the displayed default %j from %j",
  (fallback, saved) => {
    const f = settingControls(fallback, saved, true);
    f.reset();
    expect(readPluginSettingOverrides(f.root, f.configuration)).toEqual({});
    f.edit();
    expect(readPluginSettingOverrides(f.root, f.configuration)).toEqual({
      value: fallback,
    });
  },
);

test("reset removes a saved override even when it equals the plugin default", () => {
  const f = settingControls(3, 3, true);
  f.reset();
  expect(readPluginSettingOverrides(f.root, f.configuration)).toEqual({});
  expect(f.input.value).toBe("3");
  expect(f.changed).toHaveBeenCalledOnce();
  f.reset();
  expect(f.changed).toHaveBeenCalledOnce();
});

test("reset can discard an invalid numeric draft without trying to parse it", () => {
  const f = settingControls(3, 7, true);
  f.input.value = "";
  expect(() => readPluginSettingOverrides(f.root, f.configuration)).toThrow(
    "Enter a number",
  );
  f.reset();
  expect(f.input.value).toBe("3");
  expect(readPluginSettingOverrides(f.root, f.configuration)).toEqual({});
});

test("default reset controls escape public field names and JSON default values", () => {
  const configuration = {
    defaults: { "<field>": '"<unsafe>' },
    settings: { "<field>": '"<unsafe>' },
    settingOverrides: [],
  };
  const html = renderPluginSettings(configuration);
  expect(html).toContain("&lt;field&gt;");
  expect(html).not.toContain("<unsafe>");
  expect(html).toContain("Plugin default");
  expect(html).toContain("Use plugin default");
});
