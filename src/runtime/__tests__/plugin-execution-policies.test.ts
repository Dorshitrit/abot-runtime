import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import { loadConfiguredRuntimePlugins, runtimePluginsToToolModules } from "../plugins/loader.js";
import { projectManifestRuntimeContract } from "../plugins/manifest-projection.js";
import { parseToolDefinition } from "../../capabilities/tool-definition-validator.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import { REQUEST_EXECUTION_POLICY_IDS, DEFAULT_REQUEST_EXECUTION_POLICY_ID,
  isRequestExecutionPolicyId } from "../../shared/request-execution-policy.js";
import * as existingModelPolicy from "../config/model-execution-policy.js";
import { communityManifest } from "./support/plugin-installation-fixture.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function declaredManifest(executionPolicies?: unknown) {
  const manifest = communityManifest("route-fixture", "route_probe");
  if (executionPolicies !== undefined) Object.assign(manifest.extensions[ABOT_RUNTIME_EXTENSION], { executionPolicies });
  return manifest;
}

test("shares existing model-policy identifiers and keeps omission backward compatible", () => {
  expect(existingModelPolicy.REQUEST_EXECUTION_POLICY_IDS).toBe(REQUEST_EXECUTION_POLICY_IDS);
  expect(existingModelPolicy.DEFAULT_REQUEST_EXECUTION_POLICY_ID).toBe(DEFAULT_REQUEST_EXECUTION_POLICY_ID);
  expect(existingModelPolicy.isRequestExecutionPolicyId).toBe(isRequestExecutionPolicyId);
  const raw = declaredManifest();
  const parsed = parseAgentPluginManifest(raw, raw.name);
  expect(parsed.extensions[ABOT_RUNTIME_EXTENSION]).not.toHaveProperty("executionPolicies");
  const definition = parseToolDefinition({ name: "arbitrary_tool", routingCapability: "semantic_lookup", params: {} });
  expect(definition).not.toHaveProperty("executionPolicies");
});

test.each([
  ["execution-agent-v1"], ["supervisor-worker-v1"], [...REQUEST_EXECUTION_POLICY_IDS],
].map((policies) => ({ policies })))("captures a supported plugin declaration without mutating its source: $policies", ({ policies }) => {
  const source = [...policies];
  const raw = declaredManifest(source);
  const parsed = parseAgentPluginManifest(raw, raw.name);
  const captured = parsed.extensions[ABOT_RUNTIME_EXTENSION].executionPolicies;
  expect(captured).toEqual(source);
  expect(captured).not.toBe(source);
  expect(Object.isFrozen(captured)).toBe(true);
  source.splice(0);
  expect(captured).toEqual(policies);
});

test.each([
  null, [], "execution-agent-v1", {}, ["unknown"], ["execution-agent-v1", "execution-agent-v1"],
  ["execution-agent-v1", "supervisor-worker-v1", "unknown"], [null], [" execution-agent-v1"],
].map((value) => ({ value })))("rejects malformed route declarations at both manifest and tool boundaries: $value", ({ value }) => {
  const raw = declaredManifest(value);
  expect(() => parseAgentPluginManifest(raw, raw.name)).toThrow("executionPolicies");
  expect(() => parseToolDefinition({ name: "arbitrary_tool", routingCapability: "semantic_lookup", params: {},
    executionPolicies: value })).toThrow("executionPolicies");
});

test("preserves arbitrary plugin route metadata through projection, loading and registry normalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-execution-policies-"));
  roots.push(root);
  const pluginRoot = join(root, "plugins", "route-fixture");
  await mkdir(join(pluginRoot, "src"), { recursive: true });
  const raw = declaredManifest(["execution-agent-v1"]);
  const manifestPath = join(pluginRoot, "plugin.json");
  await writeFile(manifestPath, JSON.stringify(raw));
  await writeFile(join(pluginRoot, "src", "index.cjs"),
    'module.exports = { handlers: { route_probe: async () => ({ ok: true, output: "route probe", producedNewInformation: true }) } };');
  const manifest = parseAgentPluginManifest(raw, raw.name);
  const projected = projectManifestRuntimeContract({ pluginRoot, manifestPath, manifest }, ["route_probe"]);
  expect(projected.capabilities[0]!.definition.executionPolicies).toEqual(["execution-agent-v1"]);
  expect(Object.isFrozen(projected.capabilities[0]!.definition.executionPolicies)).toBe(true);

  const base = loadPublicRuntimeConfig([raw.name]);
  const config = { ...base, paths: { ...base.paths, rootDir: root, runtimeDir: join(root, ".runtime") } };
  const plugins = loadConfiguredRuntimePlugins(config);
  expect(plugins).toHaveLength(1);
  expect(plugins[0]!.capabilities[0]!.definition.executionPolicies).toEqual(["execution-agent-v1"]);
  const registry = createConfiguredToolRegistry(config, runtimePluginsToToolModules(plugins));
  expect(registry.listDefinitions()[0]!.executionPolicies).toEqual(["execution-agent-v1"]);
  expect(registry.listNormalInvocations!()[0]!.definition.executionPolicies).toEqual(["execution-agent-v1"]);
  expect(Object.isFrozen(registry.getDefinition("route_probe")!.executionPolicies)).toBe(true);
});

test.each([
  ["filesystem", ["supervisor-worker-v1"]],
  ["filesystem-ea", ["execution-agent-v1"]],
  ["system", ["execution-agent-v1"]],
] as const)("bundled %s declares its supported route in the manifest", (id, policies) => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "plugins", id, "plugin.json"), "utf8"));
  expect(parseAgentPluginManifest(raw, id).extensions[ABOT_RUNTIME_EXTENSION].executionPolicies).toEqual(policies);
});
