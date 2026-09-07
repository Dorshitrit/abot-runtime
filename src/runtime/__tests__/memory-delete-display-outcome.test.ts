import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import createMemoryPlugin from "../../../plugins/memory/source/index.js";
import { buildToolCompletedEventMetadata } from "../../capabilities/tool-event-metadata.js";
import type { ToolDefinition, ToolImplementationOutput } from "../../capabilities/tool-types.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";

const temporaryRoots: string[] = [];
const bundledMemoryPlugin = loadBundledPluginEntrypoint<
  Parameters<typeof createMemoryPlugin>[0],
  ReturnType<typeof createMemoryPlugin>
>("memory");

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function memoryContext() {
  const root = await mkdtemp(join(tmpdir(), "memory-delete-display-"));
  temporaryRoots.push(root);
  const runtimePaths = {
    rootDir: root,
    runtimeDir: join(root, ".runtime"),
    agentWorkDir: join(root, "agent-work"),
    sessionsDir: join(root, ".runtime", "sessions"),
    attachmentsDir: join(root, ".runtime", "attachments"),
    workspaceDir: join(root, "workspace"),
    sharedDir: join(root, ".runtime", "shared"),
    compiledDir: join(root, ".runtime", "compiled"),
    traceFile: join(root, ".runtime", "trace.jsonl"),
  };
  const pluginRoot = join(process.cwd(), "plugins", "memory");
  return {
    id: "memory",
    path: join(pluginRoot, "src", "index.cjs"),
    stateDir: join(runtimePaths.runtimeDir, "plugins", "memory"),
    rootDir: root,
    runtimeId: "memory-delete-display",
    agentBridgeUrl: "ws://127.0.0.1/unused",
    runtimePaths,
    runtimePathResolver: createRuntimeToolPathResolver(runtimePaths),
    pluginRoot,
  };
}

function displayedDeletion(id: string, result: ToolImplementationOutput) {
  const manifest = parseAgentPluginManifest(
    JSON.parse(readFileSync("plugins/memory/plugin.json", "utf8")),
    "memory",
  );
  const capability = manifest.extensions["ai.abot.runtime"].capabilities.memory_delete!;
  const definition: ToolDefinition = {
    name: "memory_delete",
    routingCapability: capability.routingCapability,
    params: {},
    executionEffect: "mutating",
    eventPresentation: capability.eventPresentation,
  };
  const meta = buildToolCompletedEventMetadata(
    { tool: "memory_delete", params: { id } },
    { tool: "memory_delete", ...result },
    definition,
  );
  const [action] = buildConversationToolActions({
    requestId: "delete-request",
    events: [{
      name: "tool.completed",
      requestId: "delete-request",
      executionId: "delete-execution",
      executorRole: "supervisor",
      tool: "memory_delete",
      ok: result.ok,
      meta,
    }],
  });
  return { meta, action };
}

describe.each([
  ["source", createMemoryPlugin],
  ["bundled", bundledMemoryPlugin],
] as const)("memory deletion display from the %s plugin", (_name, factory) => {
  test("projects a missing ID as zero deletions without claiming a mutation", async () => {
    const plugin = factory(await memoryContext());
    const result = await plugin.handlers.memory_delete({ id: "missing-id" });
    const { meta, action } = displayedDeletion("missing-id", result);

    expect(meta).toMatchObject({ deletedCount: 0 });
    expect(action).toMatchObject({ status: "empty", statusLabel: "No matching record" });
    expect(result).toMatchObject({
      ok: true,
      progress: false,
      producedNewInformation: false,
      data: { deletedCount: 0 },
    });
    expect(result.actions).toBeUndefined();
    expect(result.data).not.toHaveProperty("mutationEvidence");
  });

  test("retains successful deletion evidence and reports a repeated deletion as empty", async () => {
    const plugin = factory(await memoryContext());
    const added = await plugin.handlers.memory_add({ content: "A saved preference" });
    const id = String(added.data?.id);
    const deleted = await plugin.handlers.memory_delete({ id });

    expect(deleted).toMatchObject({
      ok: true,
      progress: true,
      producedNewInformation: true,
      actions: [{ type: "memory_delete", target: id }],
      data: { deletedCount: 1, mutationEvidence: true },
    });
    expect(displayedDeletion(id, deleted).action).toMatchObject({
      status: "completed",
      statusLabel: "Completed",
    });
    const repeated = await plugin.handlers.memory_delete({ id });
    expect(displayedDeletion(id, repeated).action).toMatchObject({
      status: "empty",
      statusLabel: "No matching record",
    });
    expect(repeated.progress).toBe(false);
    expect(repeated.actions).toBeUndefined();
    expect(repeated.data).not.toHaveProperty("mutationEvidence");
  });
});
