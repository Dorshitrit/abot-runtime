import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PUBLIC_PLUGIN_IDS } from "../../../scripts/public-snapshot/contracts.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import { resolvePluginPlatformCompatibility } from "../plugins/platform-compatibility.js";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import {
  createPluginSelectionFixture,
  removePluginSelectionFixtures,
} from "./plugin-selection-fixture.js";

const WINDOWS_COHORT = ["capability-brief", "code-outline", "document-reader", "exec", "filesystem", "json-inspector", "local-search", "memory", "project-orientation", "system", "system-probe", "web"];

afterEach(async () => {
  vi.unstubAllGlobals();
  await removePluginSelectionFixtures();
});

function manifest(id: string) {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "plugins", id, "plugin.json"), "utf8"));
  return parseAgentPluginManifest(raw, id);
}

describe("public native Windows plugin cohort", () => {
  test("only the validated public cohort declares Windows support", () => {
    const available = PUBLIC_PLUGIN_IDS.filter((id) =>
      resolvePluginPlatformCompatibility(manifest(id), "win32").supported,
    );
    expect(available).toEqual(WINDOWS_COHORT);
  });

  test.each(["linux", "darwin"] as const)("preserves every public plugin on %s", (platform) => {
    for (const id of PUBLIC_PLUGIN_IDS)
      expect(resolvePluginPlatformCompatibility(manifest(id), platform).supported, id).toBe(true);
  });

  test("loads the real Windows bundles while excluding undeclared and private plugins", async () => {
    const config = await createPluginSelectionFixture({ enabled: true, allow: [...PUBLIC_PLUGIN_IDS] });
    // This test changes catalog selection, not the actual host's native binary.
    // Load ripgrep under the real OS before the synthetic platform is installed.
    // Native Windows execution is covered by local-search-platform.test.ts.
    createRequire(import.meta.url)("@vscode/ripgrep");
    const nativeProcess = Object.create(process) as NodeJS.Process;
    Object.defineProperty(nativeProcess, "platform", { value: "win32" });
    vi.stubGlobal("process", nativeProcess);
    const plugins = loadConfiguredRuntimePlugins(config);
    expect(plugins.map(({ id }) => id).sort()).toEqual(WINDOWS_COHORT);
    const capabilities = plugins.flatMap((plugin) => plugin.capabilities);
    const brief = capabilities.find((tool) => tool.definition.name === "capability_brief")!;
    expect(await brief.execute({}, { sharedState: { availableTools: [] } })).toMatchObject({
      ok: true,
      data: { source: "request_effective_tool_registry", toolOperationCount: 0 },
    });
  });
});
