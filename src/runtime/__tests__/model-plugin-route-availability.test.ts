import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ABOT_RUNTIME_EXTENSION, type AgentPluginManifest } from "../../plugin-contract/manifest.js";
import { projectPluginSnapshot } from "../../web-ui/plugin-management-catalog.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { projectModelPluginSelection, setModelPluginEnabled, setModelCapabilityEnabled } from "../../web-ui/app/components/config-workspace/model-plugin-selection.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderModelPluginPermissions } from "../../web-ui/app/components/config-workspace/model-plugin-permissions.js";

function plugin(executionPolicies?: string[]) {
  return {
    id: "custom-tools", pluginEnabled: true, state: "enabled",
    blockedByGlobalPolicy: false,
    ...(executionPolicies ? { executionPolicies } : {}),
    capabilities: [{ id: "observe", enabled: true }, { id: "change", enabled: true }],
  };
}

test("catalog exposes declared execution policies without altering global selection", () => {
  const pluginRoot = join(process.cwd(), "plugins", "system-probe");
  const manifestPath = join(pluginRoot, "plugin.json");
  const source = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete source.extensions[ABOT_RUNTIME_EXTENSION].executionPolicies;
  const manifest = { pluginRoot, manifestPath, manifest: source as AgentPluginManifest };
  const config = { enabled: true, allow: ["*"], deny: ["system-probe"] };
  const original = structuredClone(config);
  const baseline = projectPluginSnapshot([manifest], config);
  source.extensions[ABOT_RUNTIME_EXTENSION].executionPolicies = ["execution-agent-v1"];
  const projected = projectPluginSnapshot([manifest], config);
  const { executionPolicies, ...selection } = projected.plugins[0]!;
  expect(executionPolicies).toEqual(["execution-agent-v1"]);
  expect(selection).toEqual(baseline.plugins[0]);
  expect(projected.selection).toEqual(baseline.selection);
  expect(config).toEqual(original);
});

test.each([
  { policy: undefined, policies: ["execution-agent-v1"], active: false },
  { policy: "supervisor-worker-v1", policies: ["execution-agent-v1"], active: false },
  { policy: "execution-agent-v1", policies: ["execution-agent-v1"], active: true },
  { policy: "execution-agent-v1", policies: ["supervisor-worker-v1"], active: false },
  { policy: "execution-agent-v1", policies: undefined, active: true },
  { policy: undefined, policies: undefined, active: true },
])("projects active=$active for policy=$policy and declaration=$policies", ({ policy, policies, active }) => {
  const selected = plugin(policies);
  const config = policy ? { execution: { policy } } : {};
  const projected = projectModelPluginSelection(config, selected, [selected]);
  expect(projected).toMatchObject({ active, activeCapabilityCount: active ? 2 : 0,
    pluginEnabled: true, selectedCapabilityCount: 2 });
  expect(Boolean(projected.inactiveReason)).toBe(!active);
  expect(Boolean(projected.controlBlockedReason)).toBe(!active);
});

test("route changes preserve saved permissions and unsupported controls cannot mutate them", () => {
  const selected = plugin(["execution-agent-v1"]);
  const catalog = [selected];
  const originalCatalog = structuredClone(catalog);
  const config = { execution: { policy: "supervisor-worker-v1" },
    plugins: { deny: [" custom-tools.change ", "unknown-rule"] } };
  const originalRules = structuredClone(config.plugins);
  expect(setModelPluginEnabled(config, catalog, selected.id, false)).toBe(false);
  expect(setModelCapabilityEnabled(config, catalog, selected.id, "observe", false)).toBe(false);
  config.execution.policy = "execution-agent-v1";
  expect(projectModelPluginSelection(config, selected, catalog)).toMatchObject({
    active: true, activeCapabilityCount: 1, state: "partial", controlBlockedReason: "",
  });
  config.execution.policy = "supervisor-worker-v1";
  expect(projectModelPluginSelection(config, selected, catalog).active).toBe(false);
  expect(config.plugins).toEqual(originalRules);
  expect(catalog).toEqual(originalCatalog);
});

test("supported routes still honor global and model restrictions independently", () => {
  const selected = plugin(["execution-agent-v1"]);
  const config = { execution: { policy: "execution-agent-v1" }, plugins: { deny: [selected.id] } };
  const denied = projectModelPluginSelection(config, selected, [selected]);
  expect(denied).toMatchObject({ active: false, pluginEnabled: false, controlBlockedReason: "" });
  expect(denied.inactiveReason).toContain("model");
  const globallyDisabled = { ...selected, pluginEnabled: false };
  const global = projectModelPluginSelection({ execution: config.execution }, globallyDisabled, [globallyDisabled]);
  expect(global).toMatchObject({ active: false, pluginEnabled: true, activeCapabilityCount: 0 });
  expect(global.inactiveReason).toBe(global.controlBlockedReason);
});

test("inactive route renders a reason and disabled controls while retaining checked permissions", () => {
  const selected = plugin(["execution-agent-v1"]);
  const file = { id: "selected-model", config: {} };
  const html = renderModelPluginPermissions(file, { plugins: [selected] });
  expect(html).toContain('data-model-plugin-active="false"');
  expect(html).toContain("Supervisor");
  expect(html).toContain("Execution Agent");
  const controls = [...html.matchAll(/<input[^>]*>/gu)].map(([input]) => input);
  expect(controls).toHaveLength(3);
  expect(controls.every((input) => input.includes("disabled") && input.includes("checked"))).toBe(true);
  const available = renderModelPluginPermissions({ ...file, config: { execution: { policy: "execution-agent-v1" } } }, { plugins: [selected] });
  expect(available).toContain('data-model-plugin-active="true"');
  expect(available).toContain("2/2 tools active");
});
