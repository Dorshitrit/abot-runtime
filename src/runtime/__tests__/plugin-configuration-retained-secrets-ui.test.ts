import { expect, test } from "vitest";
import {
  renderPluginConfigurationFields,
  readPluginConfigurationFields,
  // @ts-expect-error Browser module.
} from "../../web-ui/app/components/plugins/configuration-fields.js";

const configuration = {
  revision: "revision",
  defaults: {},
  settings: {},
  secrets: [],
  retainedSecrets: [
    {
      name: "<old-key>",
      env: "OLD_ENV",
      configured: true,
      value: "never-render-this",
    },
  ],
};

test("unused credentials render without values or replacement controls even with no current fields", () => {
  const html = renderPluginConfigurationFields(configuration);
  expect(html).toContain("Keys no longer used by this plugin");
  expect(html).toContain("&lt;old-key&gt;");
  expect(html).toContain("OLD_ENV");
  expect(html).not.toContain("never-render-this");
  expect(html).not.toContain('type="password"');
  expect(html).not.toContain("checked");
});

test("unused-key deletion is included only after explicit selection and sends no saved values", () => {
  const input = { checked: false };
  const root = { querySelector: () => input };
  expect(readPluginConfigurationFields(root, configuration)).toEqual({
    revision: "revision",
    settings: {},
    secrets: {},
  });
  input.checked = true;
  expect(readPluginConfigurationFields(root, configuration)).toEqual({
    revision: "revision",
    settings: {},
    secrets: {},
    clearRetainedSecrets: [{ name: "<old-key>", env: "OLD_ENV" }],
  });
});
