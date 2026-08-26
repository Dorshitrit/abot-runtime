import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import type { ToolImplementationOutput } from "../plugin.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";

type RuntimePaths = Readonly<{
  rootDir: string;
  agentWorkDir: string;
  workspaceDir: string;
}>;

type Handler = (
  params: Record<string, unknown>,
) => Promise<ToolImplementationOutput>;

const rootDir = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function loadManifest(pluginName: string) {
  const raw = JSON.parse(
    readFileSync(join(rootDir, "plugins", pluginName, "plugin.json"), "utf-8"),
  ) as unknown;
  return parseAgentPluginManifest(raw, pluginName);
}

function loadEntrypoint(pluginName: string) {
  return loadBundledPluginEntrypoint<
    Readonly<{
      config?: Readonly<Record<string, unknown>>;
      runtimePaths: RuntimePaths;
      runtimePathResolver: ReturnType<typeof createRuntimeToolPathResolver>;
    }>,
    Readonly<{ handlers: Readonly<Record<string, Handler>> }>
  >(pluginName);
}

async function createRoots(prefix: string): Promise<RuntimePaths> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), `${prefix}-root-`));
  const agentWorkDir = await mkdtemp(join(tmpdir(), `${prefix}-agent-work-`));
  const workspaceDir = await mkdtemp(join(tmpdir(), `${prefix}-workspace-`));
  temporaryRoots.push(runtimeRoot, agentWorkDir, workspaceDir);
  return { rootDir: runtimeRoot, agentWorkDir, workspaceDir };
}

describe("project inspection Agent Plugins parity", () => {
  test("project orientation owns one bounded read-only contract", () => {
    const extension = loadManifest("project-orientation").extensions[
      ABOT_RUNTIME_EXTENSION
    ];

    expect(extension.settings).toEqual({
      defaults: { defaultDepth: 3, maxEntries: 200 },
    });
    const capability = extension.capabilities.inspect_project;
    expect(capability.routingCapability).toBe("semantic_lookup");
    expect(capability.runtimePathBindings).toEqual([
      {
        operationId: "inspect_project",
        param: "path",
        base: "worker_working_directory",
        default: ".",
      },
    ]);
    expect(Object.keys(capability.operations)).toEqual(["inspect_project"]);
    expect(capability.operations.inspect_project).toMatchObject({
      effect: "read_only",
      approval: "request_policy",
      input: {
        type: "object",
        additionalProperties: false,
        required: [],
      },
    });
  });

  test("project orientation preserves rooted tree and manifest results", async () => {
    const roots = await createRoots("project-orientation-manifest");
    await mkdir(join(roots.agentWorkDir, "src"));
    await writeFile(
      join(roots.agentWorkDir, "package.json"),
      JSON.stringify({
        name: "fixture",
        private: true,
        scripts: { build: "tsc", validate: "npm test" },
      }),
      "utf-8",
    );
    await writeFile(
      join(roots.agentWorkDir, "src", "index.ts"),
      "export const ready = true;\n",
      "utf-8",
    );
    const extension = loadManifest("project-orientation").extensions[
      ABOT_RUNTIME_EXTENSION
    ];
    const handler = loadEntrypoint("project-orientation")({
      config: extension.settings?.defaults,
      runtimePaths: roots,
      runtimePathResolver: createRuntimeToolPathResolver(roots),
    }).handlers.inspect_project;

    expect(handler).toBeTypeOf("function");
    await expect(handler?.({ path: "." })).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("Project target: ."),
      producedNewInformation: true,
      data: {
        location: "agent_work",
        target: ".",
        depth: 3,
        maxEntries: 200,
        tree: {
          directories: ["src"],
          files: ["package.json", "src/index.ts"],
          entries: 3,
          truncated: false,
          sampling: "bounded_directory_iteration",
        },
        manifests: [
          {
            file: "package.json",
            name: "fixture",
            private: true,
            scripts: ["build", "validate"],
          },
        ],
        observationMeta: {
          kind: "volatile_external",
          carryPolicy: "never",
        },
      },
    });
    await expect(handler?.({ path: "../outside" })).resolves.toMatchObject({
      ok: false,
      errorCode: "runtime_tool_path_outside_configured_roots",
      producedNewInformation: false,
    });
  });

  test("project orientation bounds traversal and rejects an escaping manifest symlink", async () => {
    const roots = await createRoots("project-orientation-bounds");
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writeFile(
          join(roots.agentWorkDir, `file-${index}.txt`),
          "fixture",
          "utf8",
        ),
      ),
    );
    const outsidePackage = join(roots.rootDir, "outside-package.json");
    const extension = loadManifest("project-orientation").extensions[
      ABOT_RUNTIME_EXTENSION
    ];
    const handler = loadEntrypoint("project-orientation")({
      config: extension.settings?.defaults,
      runtimePaths: roots,
      runtimePathResolver: createRuntimeToolPathResolver(roots),
    }).handlers.inspect_project;

    await expect(
      handler?.({ path: ".", maxEntries: 3 }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        tree: { entries: 3, truncated: true },
      },
    });

    await writeFile(
      outsidePackage,
      JSON.stringify({ name: "outside" }),
      "utf8",
    );
    await symlink(outsidePackage, join(roots.agentWorkDir, "package.json"));
    await expect(
      handler?.({ path: ".", maxEntries: 250 }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "runtime_tool_path_symlink_escape",
    });
  });

  test("code outline owns one bounded read-only contract", () => {
    const extension =
      loadManifest("code-outline").extensions[ABOT_RUNTIME_EXTENSION];

    expect(extension.settings).toEqual({
      defaults: { defaultMaxSymbols: 160 },
    });
    const capability = extension.capabilities.inspect_code_outline;
    expect(capability.routingCapability).toBe("semantic_lookup");
    expect(capability.runtimePathBindings).toEqual([
      {
        operationId: "inspect_code_outline",
        param: "path",
        base: "worker_working_directory",
      },
    ]);
    expect(Object.keys(capability.operations)).toEqual([
      "inspect_code_outline",
    ]);
    expect(capability.operations.inspect_code_outline).toMatchObject({
      effect: "read_only",
      approval: "request_policy",
      input: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
      },
    });
  });

  test("code outline preserves bounded source structure evidence", async () => {
    const roots = await createRoots("code-outline-manifest");
    await mkdir(join(roots.agentWorkDir, "src"));
    await writeFile(
      join(roots.agentWorkDir, "src", "app.ts"),
      [
        'const { value } = require("./value.js");',
        'import helper from "./helper.js";',
        "export function start() {}",
        "export class App {}",
        "const render = () => value;",
        "",
      ].join("\n"),
      "utf-8",
    );
    const extension =
      loadManifest("code-outline").extensions[ABOT_RUNTIME_EXTENSION];
    const handler = loadEntrypoint("code-outline")({
      config: extension.settings?.defaults,
      runtimePaths: roots,
      runtimePathResolver: createRuntimeToolPathResolver(roots),
    }).handlers.inspect_code_outline;

    await expect(handler?.({ path: "src/app.ts" })).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("Code outline: src/app.ts"),
      producedNewInformation: true,
      data: {
        location: "agent_work",
        path: "src/app.ts",
        lineCount: 6,
        symbols: expect.arrayContaining([
          { kind: "function", name: "start", line: 3 },
          { kind: "class", name: "App", line: 4 },
          { kind: "function_value", name: "render", line: 5 },
        ]),
        imports: ["./helper.js", "./value.js"],
        observationMeta: {
          kind: "volatile_external",
          carryPolicy: "never",
        },
      },
    });
    const result = await handler?.({ path: "src/app.ts" });
    const symbols = Array.isArray(result?.data?.symbols)
      ? (result.data.symbols as Array<{ name?: string }>)
      : [];
    expect(symbols.filter(({ name }) => name === "render")).toHaveLength(1);
  });
});
