import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";

type RuntimePaths = Readonly<{
  rootDir: string;
  runtimeDir: string;
  agentWorkDir: string;
  sessionsDir: string;
  attachmentsDir: string;
  workspaceDir: string;
  sharedDir: string;
  compiledDir: string;
  traceFile: string;
}>;

type ExecutionContext = Readonly<{
  sharedState?: Readonly<{
    currentSessionId?: string;
    runtimePaths?: RuntimePaths;
  }>;
  modelInvoker?: Readonly<{
    invokeText(input: Record<string, unknown>): Promise<string>;
  }>;
}>;

type Handler = (
  params: Record<string, unknown>,
  context?: ExecutionContext,
) => Promise<Record<string, unknown>>;

const rootDir = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function loadManifest(pluginName: string) {
  const raw = JSON.parse(
    readFileSync(join(rootDir, "plugins", pluginName, "plugin.json"), "utf8"),
  ) as unknown;
  return parseAgentPluginManifest(raw, pluginName);
}

function loadHandlers(pluginName: string, runtimePaths: RuntimePaths) {
  const createPlugin = loadBundledPluginEntrypoint<
    Readonly<{ stateDir: string; runtimePaths: RuntimePaths }>,
    Readonly<{ handlers: Readonly<Record<string, Handler>> }>
  >(pluginName);
  return createPlugin({
    stateDir: getPluginStateDir(runtimePaths, pluginName),
    runtimePaths,
  }).handlers;
}

function getPluginStateDir(runtimePaths: RuntimePaths, pluginName: string) {
  return join(runtimePaths.runtimeDir, "plugins", pluginName);
}

async function createRuntimePaths(prefix: string): Promise<RuntimePaths> {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
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
    traceFile: join(root, ".runtime", "logs", "runtime-debug.jsonl"),
  };
  await Promise.all(
    Object.values(runtimePaths)
      .filter((directory) => directory !== root)
      .map((directory) => mkdir(directory, { recursive: true })),
  );
  return runtimePaths;
}

describe("semantic state Agent Plugin parity", () => {
  test("owns the memory contracts, event metadata and skills in its manifest", () => {
    const extension = loadManifest("memory").extensions[ABOT_RUNTIME_EXTENSION];

    expect(Object.keys(extension.capabilities)).toEqual([
      "memory_get",
      "memory_search",
      "memory_add",
      "memory_delete",
    ]);
    expect(extension.capabilities.memory_get).toMatchObject({
      routingCapability: "semantic_lookup",
      developmentRoles: ["inspect"],
      skills: ["memory_lookup_skill"],
      operations: {
        list_memory: {
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
              limit: { type: "integer", minimum: 1, maximum: 100 },
            },
            required: [],
          },
          effect: "read_only",
          approval: "request_policy",
        },
      },
    });
    expect(extension.capabilities.memory_get.description).toEqual(
      expect.any(String),
    );
    expect(extension.capabilities.memory_search).toMatchObject({
      routingCapability: "semantic_lookup",
      developmentRoles: ["inspect"],
      skills: ["memory_lookup_skill"],
      eventPresentation: {
        metadata: {
          query: { param: "query", kind: "string" },
          queryCount: { param: "query", kind: "number", default: 1 },
        },
      },
      operations: {
        search_memory: {
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string", minLength: 1, maxLength: 4_096 },
            },
            required: ["query"],
          },
          effect: "read_only",
          approval: "request_policy",
        },
      },
    });
    expect(extension.capabilities.memory_add).toMatchObject({
      routingCapability: "semantic_mutation",
      developmentRoles: ["mutate"],
      skills: ["memory_mutation_skill"],
      eventPresentation: {
        metadata: { contentLength: { param: "content", kind: "length" } },
      },
      operations: {
        add_memory: {
          effect: "mutating",
          approval: "request_policy",
        },
      },
    });
    expect(extension.capabilities.memory_delete).toMatchObject({
      routingCapability: "semantic_mutation",
      developmentRoles: ["mutate"],
      skills: ["memory_mutation_skill"],
      eventPresentation: {
        metadata: { id: { param: "id", kind: "string" } },
      },
      operations: {
        delete_memory: {
          effect: "mutating",
          approval: "request_policy",
        },
      },
    });
  });

  test("preserves memory persistence, lookup evidence and mutation results", async () => {
    const runtimePaths = await createRuntimePaths("memory-plugin");
    const handlers = loadHandlers("memory", runtimePaths);
    const context: ExecutionContext = {};

    await writeFile(
      join(runtimePaths.workspaceDir, "notes.md"),
      "The release train is Aurora.\n",
      "utf8",
    );
    await expect(
      handlers.memory_add?.(
        { content: "The user's favorite color is green" },
        context,
      ),
    ).resolves.toMatchObject({
      ok: true,
      progress: true,
      producedNewInformation: true,
      data: { mutationEvidence: true },
    });
    expect(
      JSON.parse(
        await readFile(
          join(getPluginStateDir(runtimePaths, "memory"), "memory.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      entries: [{ id: "mem-0001", content: expect.stringContaining("green") }],
    });

    await expect(handlers.memory_get?.({}, context)).resolves.toMatchObject({
      ok: true,
      progress: true,
      data: {
        hasData: true,
        itemCount: 1,
        observationMeta: { kind: "stable_fact", carryPolicy: "always" },
      },
    });
    await expect(
      handlers.memory_search?.({ query: "favorite color" }, context),
    ).resolves.toMatchObject({
      ok: true,
      progress: true,
      producedNewInformation: true,
      data: {
        hasData: true,
        memoryItemCount: 1,
        satisfiedStoredStateLookup: true,
      },
    });
    await expect(
      handlers.memory_search?.({ query: "Aurora" }, context),
    ).resolves.toMatchObject({
      ok: true,
      progress: false,
      producedNewInformation: false,
      data: {
        hasData: false,
        memoryItemCount: 0,
        satisfiedStoredStateLookup: false,
      },
    });
    await expect(
      handlers.memory_delete?.({ id: "mem-0001" }, context),
    ).resolves.toMatchObject({
      ok: true,
      progress: true,
      producedNewInformation: true,
      data: { mutationEvidence: true },
    });
    await expect(
      handlers.memory_add?.({ content: "A later preference" }, context),
    ).resolves.toMatchObject({
      ok: true,
      data: { id: "mem-0002", mutationEvidence: true },
    });
  });

  test("serializes concurrent mutations across plugin instances and returns bounded pages", async () => {
    const runtimePaths = await createRuntimePaths("memory-plugin-concurrency");
    const first = loadHandlers("memory", runtimePaths);
    const second = loadHandlers("memory", runtimePaths);

    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        (index % 2 === 0 ? first : second).memory_add?.(
          { content: `memory-${index}` },
          {},
        ),
      ),
    );
    const stored = JSON.parse(
      await readFile(
        join(getPluginStateDir(runtimePaths, "memory"), "memory.json"),
        "utf8",
      ),
    ) as { entries: Array<{ id: string; content: string }> };
    expect(stored.entries).toHaveLength(60);
    expect(new Set(stored.entries.map(({ id }) => id)).size).toBe(60);

    await expect(
      first.memory_get?.({ offset: 0, limit: 10 }, {}),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        itemCount: 60,
        returnedItemCount: 10,
        nextOffset: 10,
        truncated: true,
      },
    });
    await expect(
      second.memory_get?.({ offset: 50, limit: 10 }, {}),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        itemCount: 60,
        returnedItemCount: 10,
        offset: 50,
        truncated: false,
      },
    });
  });

  test("rejects a malformed store without silently resetting it", async () => {
    const runtimePaths = await createRuntimePaths("memory-plugin-invalid");
    const stateDir = getPluginStateDir(runtimePaths, "memory");
    await mkdir(stateDir, { recursive: true });
    const filePath = join(stateDir, "memory.json");
    const malformed = `${JSON.stringify({ entries: {} }, null, 2)}\n`;
    await writeFile(filePath, malformed, "utf8");
    const handlers = loadHandlers("memory", runtimePaths);

    await expect(handlers.memory_get?.({}, {})).resolves.toMatchObject({
      ok: false,
      errorCode: "invalid_memory_store",
      producedNewInformation: false,
    });
    await expect(readFile(filePath, "utf8")).resolves.toBe(malformed);
  });

  test("rejects an oversized store before parsing or resetting it", async () => {
    const runtimePaths = await createRuntimePaths("memory-plugin-oversized");
    const stateDir = getPluginStateDir(runtimePaths, "memory");
    await mkdir(stateDir, { recursive: true });
    const filePath = join(stateDir, "memory.json");
    await writeFile(filePath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    const handlers = loadHandlers("memory", runtimePaths);

    await expect(handlers.memory_get?.({}, {})).resolves.toMatchObject({
      ok: false,
      errorCode: "memory_store_too_large",
      producedNewInformation: false,
    });
    await expect(readFile(filePath)).resolves.toHaveLength(4 * 1024 * 1024 + 1);
  });

  test("migrates the legacy memory store once into plugin state", async () => {
    const runtimePaths = await createRuntimePaths("memory-plugin-migration");
    const legacyFile = join(runtimePaths.runtimeDir, "memory", "memory.json");
    const canonicalFile = join(
      getPluginStateDir(runtimePaths, "memory"),
      "memory.json",
    );
    const legacyStore = {
      entries: [
        {
          id: "mem-0007",
          content: "The legacy stored preference is tea",
          createdAt: "2026-08-08T00:00:00.000Z",
        },
      ],
    };
    await mkdir(join(runtimePaths.runtimeDir, "memory"), { recursive: true });
    await writeFile(
      legacyFile,
      `${JSON.stringify(legacyStore, null, 2)}\n`,
      "utf8",
    );

    const handlers = loadHandlers("memory", runtimePaths);
    await expect(handlers.memory_get?.({}, {})).resolves.toMatchObject({
      ok: true,
      progress: true,
      data: { hasData: true, itemCount: 1 },
    });
    await expect(
      readFile(canonicalFile, "utf8").then((value) => JSON.parse(value)),
    ).resolves.toEqual({ nextSequence: 8, entries: legacyStore.entries });

    await writeFile(
      legacyFile,
      `${JSON.stringify({ entries: [] }, null, 2)}\n`,
      "utf8",
    );
    await expect(handlers.memory_get?.({}, {})).resolves.toMatchObject({
      ok: true,
      progress: true,
      data: { hasData: true, itemCount: 1 },
    });
  });
});
