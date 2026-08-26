import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ABOT_RUNTIME_EXTENSION,
  ABOT_RUNTIME_EXTENSION_VERSION,
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_RESULT_SERIALIZED_MAX_BYTES,
  PluginParameterError,
  boundCollection,
  boundText,
  defineRuntimePlugin,
  failureFromError,
  readBoolean,
  readBoundedRegularFile,
  readBoundedInteger,
  readRequiredString,
  readStringArray,
  resolvePluginPath,
  successResult,
  type AgentPluginManifest,
  type RuntimePluginEntrypointFactory,
} from "../../plugin-sdk/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("public plugin SDK", () => {
  it("owns the public manifest and entrypoint contract", () => {
    const manifest: AgentPluginManifest = {
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
      name: "example-plugin",
      extensions: {
        [ABOT_RUNTIME_EXTENSION]: {
          version: ABOT_RUNTIME_EXTENSION_VERSION,
          entrypoint: "./src/index.cjs",
          capabilities: {},
        },
      },
    };

    expect(manifest.extensions[ABOT_RUNTIME_EXTENSION].version).toBe(1);
  });

  it("preserves plugin factory identity and delegates paths to the host", () => {
    const factory: RuntimePluginEntrypointFactory = () => ({ handlers: {} });
    expect(defineRuntimePlugin(factory)).toBe(factory);

    const resolved = {
      location: "workspace" as const,
      rootPath: "/workspace",
      absolutePath: "/workspace/src/file.ts",
      relativePath: "src/file.ts",
      logicalPath: "workspace/src/file.ts",
    };
    const resolve = (rawPath: unknown) => {
      expect(rawPath).toBe("workspace/src/file.ts");
      return resolved;
    };
    expect(
      resolvePluginPath(
        { runtimePathResolver: { resolve } },
        "workspace/src/file.ts",
        { allowedLocations: ["workspace"] },
      ),
    ).toBe(resolved);
  });

  it("produces deterministic bound metadata", () => {
    expect(boundText("abcdefgh", { maxChars: 5, marker: ".." })).toEqual({
      text: "abc..",
      metadata: {
        truncated: true,
        originalChars: 8,
        returnedChars: 5,
        omittedChars: 5,
      },
    });
    expect(boundCollection([1, 2, 3], { maxItems: 2 })).toEqual({
      items: [1, 2],
      metadata: {
        truncated: true,
        totalItems: 3,
        returnedItems: 2,
        omittedItems: 1,
      },
    });
  });

  it("parses parameters without silent coercion", () => {
    expect(readRequiredString("  value ", { parameter: "name" })).toBe("value");
    expect(
      readBoundedInteger(undefined, {
        parameter: "limit",
        minimum: 1,
        maximum: 10,
        defaultValue: 4,
      }),
    ).toBe(4);
    expect(readBoolean(undefined, { defaultValue: false })).toBe(false);
    expect(readStringArray([" a ", "a", "b"], { parameter: "paths" })).toEqual([
      "a",
      "b",
    ]);
    expect(() => readRequiredString(undefined, { parameter: "name" })).toThrow(
      PluginParameterError,
    );
    expect(() =>
      readBoundedInteger(0, {
        parameter: "limit",
        minimum: 1,
        maximum: 10,
      }),
    ).toThrow(PluginParameterError);
  });

  it("keeps canonical path failures and sanitizes unknown errors", () => {
    const pathError = Object.assign(new TypeError("physical path detail"), {
      code: "runtime_tool_path_symlink_escape",
    });
    expect(
      failureFromError(pathError, {
        fallbackCode: "inspect_failed",
        fallbackMessage: "Inspection failed",
        operation: "Inspection",
      }),
    ).toMatchObject({
      ok: false,
      errorCode: "runtime_tool_path_symlink_escape",
      error: "runtime_tool_path_symlink_escape",
      output: "Inspection failed: runtime_tool_path_symlink_escape",
      producedNewInformation: false,
    });
    const unknown = failureFromError(new Error("secret physical detail"), {
      fallbackCode: "inspect_failed",
      fallbackMessage: "Inspection failed",
    });
    expect(unknown).toMatchObject({
      errorCode: "inspect_failed",
      error: "Inspection failed",
      output: "Inspection failed",
    });
    expect(unknown.output).not.toContain("physical detail");
  });

  it("creates complete success results without inventing progress", () => {
    expect(
      successResult({ output: "done", data: { hasData: true, itemCount: 1 } }),
    ).toEqual({
      ok: true,
      output: "done",
      producedNewInformation: true,
      data: { hasData: true, itemCount: 1 },
    });
  });

  it("fails closed before a plugin result can exceed the runtime boundary", () => {
    expect(
      successResult({
        output: "done",
        data: { payload: "x".repeat(PLUGIN_RESULT_SERIALIZED_MAX_BYTES) },
      }),
    ).toMatchObject({
      ok: false,
      errorCode: "plugin_result_too_large",
      producedNewInformation: false,
    });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(successResult({ output: "done", data: cyclic })).toMatchObject({
      ok: false,
      errorCode: "plugin_result_not_json_safe",
      producedNewInformation: false,
    });
  });

  it("reads regular files through one bounded handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-sdk-file-"));
    temporaryRoots.push(root);
    const filePath = join(root, "value.txt");
    const directoryPath = join(root, "directory");
    await writeFile(filePath, "bounded value", "utf8");
    await mkdir(directoryPath);

    await expect(
      readBoundedRegularFile(filePath, { maxBytes: 64, rootPath: root }),
    ).resolves.toMatchObject({
      ok: true,
      byteCount: 13,
      bytes: Buffer.from("bounded value"),
    });
    await expect(
      readBoundedRegularFile(filePath, { maxBytes: 4, rootPath: root }),
    ).resolves.toEqual({ ok: false, reason: "too_large", byteCount: 13 });
    await expect(
      readBoundedRegularFile(directoryPath, { maxBytes: 64, rootPath: root }),
    ).resolves.toEqual({ ok: false, reason: "not_regular_file" });

    const outsideRoot = await mkdtemp(join(tmpdir(), "plugin-sdk-outside-"));
    temporaryRoots.push(outsideRoot);
    await writeFile(join(outsideRoot, "outside.txt"), "outside", "utf8");
    await symlink(outsideRoot, join(root, "redirect"), "dir");
    await expect(
      readBoundedRegularFile(join(root, "redirect", "outside.txt"), {
        maxBytes: 64,
        rootPath: root,
      }),
    ).resolves.toEqual({ ok: false, reason: "outside_root" });
  });
});
