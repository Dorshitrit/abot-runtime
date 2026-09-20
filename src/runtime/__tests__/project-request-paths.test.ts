import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { bindRequestToolRegistry } from "../capabilities/request-bound-tool-registry.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createRuntimeProjectService } from "../projects/service.js";
import {
  resolveSessionWorkingDirectory,
  projectSessionRuntimePaths,
} from "../projects/session-paths.js";
import { createProjectFixture } from "./support/project-fixture.js";

const readTarget: ToolModuleDeclaration = {
  definition: {
    name: "read_target",
    routingCapability: "filesystem_inspection",
  },
  implementation: async (params, context) => {
    const resolved = context!.runtimePathResolver!.resolve(
      String(params.path),
      { allowedLocations: ["agent_work", "workspace"], requirePath: true },
    );
    await Promise.resolve();
    const output = await readFile(resolved.absolutePath, "utf8");
    return {
      ok: true,
      output,
      producedNewInformation: true,
      data: { root: context!.sharedState!.runtimePaths!.agentWorkDir },
    };
  },
  normalInvocation: {
    version: 1,
    operations: [
      {
        operationId: "read_target",
        summary: "Read target",
        effect: "read_only",
        approval: "request_policy",
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4096 },
          },
          required: ["path"],
        },
      },
    ],
  },
};

describe("request-scoped project paths", () => {
  test("concurrent project and ordinary execution use exact captured roots without config mutation", async () => {
    const fixture = await createProjectFixture();
    try {
      const sessions = createInMemorySessionStore();
      const projects = createRuntimeProjectService(fixture.config, sessions);
      const a = await projects.create({ directory: fixture.directories[2]! });
      const b = await projects.create({ directory: fixture.directories[3]! });
      const opened = await Promise.all([
        projects.createSession(a.id),
        projects.createSession(b.id),
      ]);
      const records = await Promise.all(
        opened.map((entry) => sessions.getSessionById(entry.sessionId)),
      );
      const configBefore = JSON.stringify(fixture.config);
      const originalCwd = process.cwd();
      await Promise.all(
        fixture.directories.map((directory, index) =>
          writeFile(join(directory, "file.txt"), String(index)),
        ),
      );
      const registry = createConfiguredToolRegistry(fixture.config, [
        readTarget,
      ]);
      const modelInvoker = { invokeText: vi.fn() };
      const scoped = records.map((record) =>
        bindRequestToolRegistry({
          registry,
          modelInvoker,
          requestWorkingDirectory: resolveSessionWorkingDirectory(record!),
        }),
      );
      const ordinary = bindRequestToolRegistry({ registry, modelInvoker });
      const results = await Promise.all(
        [...scoped, ordinary].map((bound) =>
          bound.execute(
            { tool: "read_target", params: { path: "file.txt" } },
            { sharedState: bound.prepareSharedState!() },
          ),
        ),
      );
      expect(results.map((result) => result.output)).toEqual(["2", "3", "0"]);
      expect(
        (
          await scoped[0]!.execute({
            tool: "read_target",
            params: { path: "workspace/file.txt" },
          })
        ).output,
      ).toBe("1");
      expect(JSON.stringify(fixture.config)).toBe(configBefore);
      expect(process.cwd()).toBe(originalCwd);
      expect(
        projectSessionRuntimePaths(fixture.config.paths, records[0]!)
          .agentWorkDir,
      ).toBe(a.directory);
      expect(
        projectSessionRuntimePaths(fixture.config.paths, records[0]!)
          .workspaceDir,
      ).toBe(fixture.config.paths.workspaceDir);
    } finally {
      await fixture.close();
    }
  });
});
