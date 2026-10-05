import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { validateToolNormalInvocationInput } from "../../capabilities/normal-invocation/validator.js";
import { selectedSystemModules } from "./support/system-request-plugin-fixture.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

test("keyboard guidance is projected from the plugin while inputs retain platform-specific key names", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../plugins/system/plugin.json", import.meta.url), "utf8"));
  const declared = manifest.extensions["ai.abot.runtime"].capabilities.computer_act.operations;
  const registry = createConfiguredToolRegistry(loadPublicRuntimeConfig(["system"]), selectedSystemModules(["computer_act"]));
  const operations = registry.listNormalInvocations!().find(({ toolName }) => toolName === "computer_act")!.contract.operations;
  const keyboard = operations.find((operation) => operation.operationId === "computer_press_keys")!;
  expect(keyboard.summary).toBe(declared.computer_press_keys.summary);
  expect(keyboard.summary.length).toBeLessThanOrEqual(512);
  expect(keyboard.input.properties.keys).toEqual({
    type: "array", items: { type: "string", minLength: 1, maxLength: 32 }, minItems: 1, maxItems: 8,
  });
  for (const keys of [["CMD", "L"], ["Command", "l"], ["Control", "L"], ["XF86AudioMute"]]) {
    expect(validateToolNormalInvocationInput(keyboard, { desktop_ref: "desktop", observation_ref: "observation", keys }).ok).toBe(true);
  }
  expect(validateToolNormalInvocationInput(keyboard, { desktop_ref: "desktop", observation_ref: "observation", keys: "CMD+L" }).ok).toBe(false);
  expect(validateToolNormalInvocationInput(keyboard, { desktop_ref: "desktop", observation_ref: "observation", keys: [] }).ok).toBe(false);
  for (const operation of operations) {
    expect(operation.summary).toBe(declared[operation.operationId].summary);
    expect(operation.input).toEqual(declared[operation.operationId].input);
    expect(operation.approval).toBe("always");
  }
});
