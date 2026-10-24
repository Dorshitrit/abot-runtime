import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import createSource from "../../../plugins/project-orientation/source/index.js";
import type { RuntimePluginEntrypointFactory } from "../../plugin-sdk/index.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

const statFailures = vi.hoisted(() => new Map<string, () => Error>());
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      const failure = statFailures.get(String(args[0]));
      if (failure) throw failure();
      return fs.stat(...args);
    },
  };
});
const createBundle = loadBundledPluginEntrypoint<
  Parameters<RuntimePluginEntrypointFactory>[0],
  ReturnType<RuntimePluginEntrypointFactory>
>("project-orientation");
afterEach(async () => {
  statFailures.clear();
  await removePortablePluginFixtures();
});

describe.each([
  ["source", createSource],
  ["bundle", createBundle],
] as const)("project target diagnostics (%s)", (_name, create) => {
  test.each(["relative", "default root"] as const)(
    "identifies a missing %s without exposing filesystem paths",
    async (kind) => {
      const context = await createPortablePluginFixture("project-orientation");
      if (kind === "relative") await mkdir(context.runtimePaths.agentWorkDir);
      const result = await create(context).handlers.inspect_project!(
        kind === "relative" ? { path: "not-created-yet" } : {},
      );
      expect(result).toMatchObject({
        ok: false,
        errorCode: "project_target_not_found",
        error: "The requested project directory does not exist.",
        output: "The requested project directory does not exist.",
        producedNewInformation: false,
      });
      expect(result.data).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(context.rootDir);
    },
  );

  test("accepts an existing empty project", async () => {
    const context = await createPortablePluginFixture("project-orientation");
    await mkdir(context.runtimePaths.agentWorkDir);
    expect(await create(context).handlers.inspect_project!({})).toMatchObject({
      ok: true,
      data: { target: ".", tree: { directories: [], files: [] }, manifests: [] },
    });
  });

  test("keeps a regular file distinct from a missing project", async () => {
    const context = await createPortablePluginFixture("project-orientation");
    await mkdir(context.runtimePaths.agentWorkDir);
    await writeFile(join(context.runtimePaths.agentWorkDir, "note.txt"), "body");
    expect(await create(context).handlers.inspect_project!({ path: "note.txt" })).toMatchObject({
      ok: false,
      errorCode: "project_target_not_directory",
      output: "The requested project target is not a directory.",
    });
  });
});

test.each(["EACCES", "EPERM"])("keeps %s distinct from a missing project", async (code) => {
  const context = await createPortablePluginFixture("project-orientation");
  await mkdir(context.runtimePaths.agentWorkDir);
  statFailures.set(context.runtimePaths.agentWorkDir, () => Object.assign(new Error("private filesystem details"), { code }));
  const result = await createSource(context).handlers.inspect_project!({});
  expect(result).toMatchObject({
    ok: false, errorCode: "project_orientation_failed",
    output: "inspect_project failed: Project orientation failed.",
  });
  expect(result.output).not.toContain("private filesystem details");
});

test("does not classify a disappearing child as a missing project", async () => {
  const context = await createPortablePluginFixture("project-orientation");
  await mkdir(context.runtimePaths.agentWorkDir);
  const child = join(context.runtimePaths.agentWorkDir, "disappearing.txt");
  await writeFile(child, "body");
  statFailures.set(child, () => Object.assign(new Error("gone"), { code: "ENOENT" }));
  expect(await createSource(context).handlers.inspect_project!({})).toMatchObject({
    ok: false, errorCode: "project_orientation_failed",
    output: "inspect_project failed: Project orientation failed.",
  });
});

test("preserves cancellation when the initial target lookup fails", async () => {
  const context = await createPortablePluginFixture("project-orientation");
  await mkdir(context.runtimePaths.agentWorkDir);
  const controller = new AbortController();
  statFailures.set(context.runtimePaths.agentWorkDir, () => {
    controller.abort();
    return Object.assign(new Error("gone"), { code: "ENOENT" });
  });
  expect(await createSource(context).handlers.inspect_project!({}, { abortSignal: controller.signal })).toMatchObject({
    ok: false, errorCode: "project_inspection_cancelled", interruption: "aborted",
  });
});
