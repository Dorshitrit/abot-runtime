import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import type { RuntimePluginEntrypoint } from "../../plugin-sdk/index.js";
import { buildToolCompletedEventMetadata } from "../../capabilities/tool-event-metadata.js";
import { createConversationTools } from "../../web-ui/app/components/conversation-tools.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

const createCodeOutlinePlugin = loadBundledPluginEntrypoint<
  Record<string, unknown>,
  RuntimePluginEntrypoint
>("code-outline");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.each([40, 41])(
  "outline activity represents the complete import coverage for %i imports",
  async (importCount) => {
    const root = await mkdtemp(join(tmpdir(), "outline-activity-"));
    temporaryRoots.push(root);
    const runtimePaths = {
      rootDir: root,
      agentWorkDir: root,
      workspaceDir: join(root, "workspace"),
    };
    await writeFile(
      join(root, "imports.ts"),
      Array.from(
        { length: importCount },
        (_, index) => `import "dep${index}";`,
      ).join("\n"),
    );
    const plugin = createCodeOutlinePlugin({
      rootDir: root,
      runtimePaths,
      runtimePathResolver: createRuntimeToolPathResolver(runtimePaths),
    });
    const params = { path: "imports.ts" };
    const result = await plugin.handlers.inspect_code_outline!(params);
    const partial = importCount > 40;
    expect(result).toMatchObject({
      ok: true,
      data: {
        truncation: {
          importsTruncated: partial,
          returnedImports: 40,
          totalImports: importCount,
          symbolsTruncated: false,
          output: { truncated: false },
        },
      },
    });
    const before = structuredClone(result);
    const manifest = parseAgentPluginManifest(
      JSON.parse(readFileSync("plugins/code-outline/plugin.json", "utf8")),
      "code-outline",
    );
    const capability =
      manifest.extensions["ai.abot.runtime"].capabilities.inspect_code_outline!;
    const tool = "inspect_code_outline";
    const meta = buildToolCompletedEventMetadata(
      { tool, params },
      { tool, ...result },
      {
        name: tool,
        params: {},
        executionEffect: "read_only",
        routingCapability: capability.routingCapability,
        eventPresentation: capability.eventPresentation,
      },
    );
    const requestId = "outline-request";
    const actions = buildConversationToolActions({
      requestId,
      events: [
        {
          requestId,
          name: "tool.completed",
          executionId: "outline-execution",
          tool,
          ok: true,
          meta,
        },
      ],
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      status: "completed",
      target: "imports.ts",
      partial,
    });
    expect(meta).toMatchObject({
      importsTruncated: partial,
      sourceTruncated: false,
      outputTruncated: false,
    });
    const documentRoot = {
      createElement: (tag: string) => new ContextElement(tag),
    } as unknown as Document;
    const node = createConversationTools({ documentRoot }).createNode({
      requestId,
      actions,
    })!;
    const notice = node.querySelector(".conversation-tool-notice");
    expect(notice?.textContent ?? "").toBe(partial ? "Partial result" : "");
    expect(result).toEqual(before);
  },
);
