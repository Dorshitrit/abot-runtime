import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolCall } from "../../capabilities/tool-types.js";
import type { RuntimeConfig } from "../ports.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { bindRequestToolRegistry } from "../capabilities/request-bound-tool-registry.js";
import {
  loadConfiguredRuntimePlugins,
  runtimePluginsToToolModules,
} from "../plugins/loader.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

const fixtureRoots: string[] = [];

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  resetDebugLoggerConfig();
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeProject(directory: string, marker: string): Promise<void> {
  await mkdir(join(directory, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(directory, "needle.txt"), `needle ${marker}\n`),
    writeFile(
      join(directory, "marker.json"),
      JSON.stringify({ [marker]: true }),
    ),
    writeFile(
      join(directory, "src", "app.ts"),
      `export function ${marker}() {}\n`,
    ),
    writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: marker, scripts: { [marker]: "echo fixture" } }),
    ),
  ]);
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "plugin-request-directory-"));
  fixtureRoots.push(root);
  const agentWorkDir = join(root, "configured");
  const workspaceDir = join(root, "workspace");
  const projectA = join(agentWorkDir, "project-a");
  const projectB = join(agentWorkDir, "project-b");
  await Promise.all([
    writeProject(agentWorkDir, "configuredOnly"),
    writeProject(projectA, "projectAOnly"),
    writeProject(projectB, "projectBOnly"),
    writeProject(workspaceDir, "workspaceOnly"),
  ]);
  await mkdir(join(agentWorkDir, "sibling-trap"));
  await writeFile(
    join(agentWorkDir, "sibling-trap", "needle-trap.txt"),
    "needle siblingTrap\n",
  );
  const config: RuntimeConfig = {
    runtimeId: "plugin-request-directory-test",
    agentBridgeUrl: "ws://127.0.0.1:1",
    modelGatewayUrl: "http://127.0.0.1:1",
    requestRunner: { configPath: join(root, "request-runner.json") },
    plugins: {
      allow: [
        "local_search",
        "inspect_project",
        "inspect_json",
        "inspect_code_outline",
        "system_probe",
        "dev_view",
      ],
    },
    paths: {
      rootDir: root,
      runtimeDir: join(root, "runtime"),
      agentWorkDir,
      workspaceDir,
      sessionsDir: join(root, "sessions"),
      attachmentsDir: join(root, "attachments"),
      sharedDir: join(root, "shared"),
      compiledDir: join(root, "compiled"),
      traceFile: join(root, "trace.jsonl"),
    },
  };
  const registry = createConfiguredToolRegistry(
    config,
    runtimePluginsToToolModules(loadConfiguredRuntimePlugins(config)),
  );
  const modelInvoker = { invokeText: vi.fn() };
  const bind = (requestWorkingDirectory?: string) =>
    bindRequestToolRegistry({
      registry,
      modelInvoker,
      requestWorkingDirectory,
    });
  return {
    config,
    registry,
    a: bind(projectA),
    b: bind(projectB),
    ordinary: bind(),
  };
}

describe("bundled plugins with request-scoped working directories", () => {
  test.each(["names", "content"] as const)(
    "%s search stays inside the nested request project and returns reusable paths",
    async (mode) => {
      const { a } = await createFixture();
      const search = await a.execute({
        tool: "local_search",
        params: { path: ".", query: "needle", mode, max_results: 20 },
      });
      expect(search).toMatchObject({
        ok: true,
        data: { logicalRoot: ".", itemCount: 1 },
      });
      expect(search.output).not.toContain("sibling");
      expect(search.output).not.toContain("project-a/");
      expect(search.output).not.toContain("project-b");
      const returnedPath = search.output.match(
        /^- (needle\.txt)(?::1:.*)?$/m,
      )?.[1];
      expect(returnedPath).toBe("needle.txt");
      const read = await a.execute({
        tool: "dev_view",
        params: { path: returnedPath },
      });
      expect(read.ok).toBe(true);
      expect(read.output).toContain("needle projectAOnly");
      expect(read.output).not.toContain("configuredOnly");
    },
  );

  test("project inspection keeps its tree and manifests inside the request root", async () => {
    const { a } = await createFixture();
    const result = await a.execute({
      tool: "inspect_project",
      params: { path: ".", depth: 2 },
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        location: "agent_work",
        target: ".",
        tree: {
          directories: ["src"],
          files: ["marker.json", "needle.txt", "package.json", "src/app.ts"],
        },
        manifests: [
          {
            file: "package.json",
            name: "projectAOnly",
            scripts: ["projectAOnly"],
          },
        ],
      },
    });
    expect(result.output).not.toContain("sibling-trap");
    expect(result.output).not.toContain("configuredOnly");
    const read = await a.execute({
      tool: "dev_view",
      params: { path: "src/app.ts" },
    });
    expect(read.ok).toBe(true);
    expect(read.output).toContain("projectAOnly");
  });

  test.each([
    { tool: "inspect_json", params: { path: "marker.json" } },
    { tool: "inspect_code_outline", params: { path: "src/app.ts" } },
  ])(
    "$tool isolates concurrent requests sharing one loaded registry",
    async (call) => {
      const { config, a, b, ordinary } = await createFixture();
      const beforeConfig = JSON.stringify(config);
      const beforeCwd = process.cwd();
      const results = await Promise.all([
        a.execute(call),
        b.execute(call),
        ordinary.execute(call),
      ]);
      for (const [index, marker] of [
        "projectAOnly",
        "projectBOnly",
        "configuredOnly",
      ].entries()) {
        expect(results[index]).toMatchObject({
          ok: true,
          data: { location: "agent_work", path: call.params.path },
        });
        expect(results[index]!.output).toContain(marker);
        for (const other of [
          "projectAOnly",
          "projectBOnly",
          "configuredOnly",
        ].filter((value) => value !== marker)) {
          expect(results[index]!.output).not.toContain(other);
        }
      }
      const repeated = await a.execute(call);
      expect(repeated.output).toContain("projectAOnly");
      expect(JSON.stringify(config)).toBe(beforeConfig);
      expect(process.cwd()).toBe(beforeCwd);
    },
  );

  test("explicit workspace paths retain their configured namespace during a project request", async () => {
    const { a } = await createFixture();
    const calls: ToolCall[] = [
      {
        tool: "local_search",
        params: { path: "workspace", query: "needle", mode: "names" },
      },
      { tool: "inspect_project", params: { path: "workspace" } },
      { tool: "inspect_json", params: { path: "workspace/marker.json" } },
      {
        tool: "inspect_code_outline",
        params: { path: "workspace/src/app.ts" },
      },
    ];
    const [search, project, json, outline] = await Promise.all(
      calls.map((call) => a.execute(call)),
    );
    expect(search).toMatchObject({
      ok: true,
      data: { logicalRoot: "workspace", itemCount: 1 },
    });
    expect(search!.output).toContain("- workspace/needle.txt");
    expect(project).toMatchObject({
      ok: true,
      data: {
        location: "workspace",
        target: "workspace",
        manifests: [{ name: "workspaceOnly" }],
      },
    });
    expect(json).toMatchObject({
      ok: true,
      data: { location: "workspace", path: "workspace/marker.json" },
    });
    expect(json!.output).toContain("workspaceOnly");
    expect(outline).toMatchObject({
      ok: true,
      data: { location: "workspace", path: "workspace/src/app.ts" },
    });
    expect(outline!.output).toContain("workspaceOnly");
    const read = await a.execute({
      tool: "dev_view",
      params: { path: "workspace/needle.txt" },
    });
    expect(read.ok).toBe(true);
    expect(read.output).toContain("needle workspaceOnly");
  });

  test("disk probes use request-relative paths and preserve the default host root", async () => {
    const { config, registry, a, b, ordinary } = await createFixture();
    await mkdir(join(config.paths.agentWorkDir, "project-a", "request-only"));
    const call = { tool: "system_probe", params: { path: "request-only" } };
    const [selected, other, configured] = await Promise.all([
      a.execute(call),
      b.execute(call),
      ordinary.execute(call),
    ]);
    expect(selected).toMatchObject({
      ok: true,
      data: { diskPath: "request-only", diskStatus: "available" },
    });
    expect(other).toMatchObject({
      ok: false,
      errorCode: "system_probe_path_not_found",
    });
    expect(configured).toMatchObject({
      ok: false,
      errorCode: "system_probe_path_not_found",
    });
    const [requestDefault, directDefault, directRelative] = await Promise.all([
      a.execute({ tool: "system_probe", params: {} }),
      registry.getImplementations().system_probe!({}),
      registry.getImplementations().system_probe!({ path: "src" }),
    ]);
    expect(requestDefault).toMatchObject({ ok: true, data: { diskPath: "/" } });
    expect(directDefault).toMatchObject({ ok: true, data: { diskPath: "/" } });
    expect(directRelative).toMatchObject({
      ok: true,
      data: { diskPath: "src", diskStatus: "available" },
    });
  });

  test("direct plugin calls without execution context keep the configured fallback", async () => {
    const { registry } = await createFixture();
    const calls: ToolCall[] = [
      {
        tool: "local_search",
        params: { path: "needle.txt", query: "needle", mode: "content" },
      },
      { tool: "inspect_project", params: { path: ".", depth: 0 } },
      { tool: "inspect_json", params: { path: "marker.json" } },
      { tool: "inspect_code_outline", params: { path: "src/app.ts" } },
    ];
    const implementations = registry.getImplementations();
    for (const call of calls) {
      const result = await implementations[call.tool]!(call.params);
      expect(result.ok).toBe(true);
      expect(result.output).toContain("configuredOnly");
    }
  });
});
