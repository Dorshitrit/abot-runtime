import { isAbsolute, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildRuntimeFilesystemScopeMessage,
  canEstablishRuntimeWorkingDirectory,
  captureRuntimeFilesystemScope,
  needsRuntimeFilesystemScope,
} from "../context/runtime-filesystem-scope.js";

const root = resolve("agent-work");
const pathCapability = Object.freeze({ runtimePathControlIds: ["path"] });

describe("runtime filesystem scope", () => {
  test("captures the exact bound root once without inventing other roots", () => {
    const scope = captureRuntimeFilesystemScope(root)!;
    expect(scope).toEqual({
      agentWorkRoot: root,
      hostPathSyntax: process.platform === "win32" ? "win32" : "posix",
    });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(isAbsolute(scope.agentWorkRoot)).toBe(true);
    expect(Object.keys(scope)).toEqual(["agentWorkRoot", "hostPathSyntax"]);
  });

  test("keeps legacy constructors without a bound root unchanged", () => {
    expect(captureRuntimeFilesystemScope()).toBeUndefined();
    expect(
      buildRuntimeFilesystemScopeMessage({
        capabilities: [pathCapability],
        canSelectWorkingDirectory: true,
      }),
    ).toBeUndefined();
  });

  test("rejects a relative root rather than rebasing or guessing an OS mapping", () => {
    expect(() => captureRuntimeFilesystemScope("relative/project")).toThrow(
      "runtime_filesystem_scope_root_invalid",
    );
  });

  test.each([
    { descriptors: [], select: false, expected: false },
    { descriptors: [{}], select: false, expected: false },
    {
      descriptors: [{ runtimePathControlIds: [] }],
      select: false,
      expected: false,
    },
    { descriptors: [pathCapability], select: false, expected: true },
    { descriptors: [{}], select: true, expected: true },
  ])(
    "uses descriptor path metadata or cwd authority: $expected",
    ({ descriptors, select, expected }) => {
      expect(needsRuntimeFilesystemScope(descriptors, select)).toBe(expected);
      expect(
        buildRuntimeFilesystemScopeMessage({
          scope: captureRuntimeFilesystemScope(root),
          capabilities: descriptors,
          canSelectWorkingDirectory: select,
        }) !== undefined,
      ).toBe(expected);
    },
  );

  test.each([
    { directory: undefined, available: false, expected: false },
    { directory: undefined, available: true, expected: true },
    { directory: ".", available: true, expected: false },
    { directory: "project", available: true, expected: false },
  ])(
    "requires an available invocation and an unset canonical directory: $expected",
    ({ directory, available, expected }) => {
      expect(canEstablishRuntimeWorkingDirectory(directory, available)).toBe(
        expected,
      );
    },
  );

  test("preserves exact root and call scope as passive required reference data", () => {
    const exactRoot = resolve("space and unicode שורש", "segment".repeat(500));
    const message = buildRuntimeFilesystemScopeMessage({
      scope: captureRuntimeFilesystemScope(exactRoot),
      workingDirectory: "project/subdirectory",
      capabilities: [pathCapability],
    })!;
    const capsule = JSON.parse(message.content as string);
    expect(message.role).toBe("system");
    expect(Object.isFrozen(message)).toBe(true);
    expect(capsule).toMatchObject({
      kind: "runtime_filesystem_scope_v1",
      authority: "canonical_runtime_state",
      provenance: "request_bound_agent_work_directory",
      agentWorkRoot: exactRoot,
      workingDirectory: "project/subdirectory",
      applicability: { canSelectWorkingDirectory: false },
    });
    expect(capsule).not.toHaveProperty("workspaceDir");
    expect(capsule).not.toHaveProperty("target");
    expect(capsule).not.toHaveProperty("files");
    expect(capsule).not.toHaveProperty("history");
  });

  test("projects a Windows host scope without converting its namespace", () => {
    const message = buildRuntimeFilesystemScopeMessage({
      scope: Object.freeze({
        agentWorkRoot: "C:\\Users\\runtime\\Agent Work",
        hostPathSyntax: "win32",
      }),
      workingDirectory: "project",
      capabilities: [pathCapability],
    })!;
    expect(JSON.parse(message.content as string)).toMatchObject({
      hostPathSyntax: "win32",
      agentWorkRoot: "C:\\Users\\runtime\\Agent Work",
      workingDirectory: "project",
    });
    expect(message.content).not.toContain("/mnt/c");
  });

  test("retains distinct concurrent call scopes without mutating the request root", () => {
    const scope = captureRuntimeFilesystemScope(root);
    const project = (workingDirectory: string) =>
      JSON.parse(
        buildRuntimeFilesystemScopeMessage({
          scope,
          workingDirectory,
          capabilities: [pathCapability],
        })!.content as string,
      );
    expect(project("project-a").workingDirectory).toBe("project-a");
    expect(project("project-b").workingDirectory).toBe("project-b");
    expect(project("project-a").workingDirectory).toBe("project-a");
    expect(scope).not.toHaveProperty("workingDirectory");
  });
});
