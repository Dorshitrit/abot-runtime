import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import type { RuntimePluginEntrypointFactory } from "../../plugin-contract/entrypoint.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import { resolvePluginPlatformCompatibility } from "../plugins/platform-compatibility.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";
import { createPortablePluginFixture, removePortablePluginFixtures } from "./windows-portable-plugins-fixture.js";

afterEach(removePortablePluginFixtures);

test.each(["capability-brief", "code-outline", "document-reader", "json-inspector", "local-search", "memory", "project-orientation", "web", "exec"])("%s declares compatibility without dropping existing platforms", async (name) => {
  const manifest = parseAgentPluginManifest(JSON.parse(await readFile(
    join(process.cwd(), "plugins", name, "plugin.json"), "utf8",
  )), name);
  for (const platform of ["linux", "darwin", "win32"] as const) {
    expect(resolvePluginPlatformCompatibility(manifest, platform)).toMatchObject({
      supported: true,
      status: "declared",
      runtimePlatform: platform,
    });
  }
});

test("bundled capability brief reports only the effective request tools", async () => {
  const context = await createPortablePluginFixture("capability-brief");
  const create = loadBundledPluginEntrypoint<
    Parameters<RuntimePluginEntrypointFactory>[0],
    ReturnType<RuntimePluginEntrypointFactory>
  >("capability-brief");
  const brief = await create(context).handlers.capability_brief!({}, {
    sharedState: { availableTools: [{
      toolName: "web_fetch",
      operationId: "fetch_one",
      summary: "Fetch one public page.",
      catalogGroups: ["web"],
      effect: "read_only",
    }] },
  });
  expect(brief).toMatchObject({ ok: true, data: { toolOperationCount: 1 } });
  expect(brief.output).toContain("web_fetch");
  expect(brief.output).not.toContain("filesystem");
  expect(await create(context).handlers.capability_brief!({})).toMatchObject({
    ok: false,
    errorCode: "available_tool_catalog_unavailable",
  });
});
