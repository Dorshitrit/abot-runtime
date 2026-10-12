import {
  mkdir,
  readFile,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import createSource from "../../../plugins/document-reader/source/index.js";
import type { RuntimePluginEntrypointFactory } from "../../plugin-sdk/index.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";
import {
  DOCUMENT_FORMATS,
  platformDocument,
} from "./document-reader-platform-fixtures.js";

const createBundle = loadBundledPluginEntrypoint<
  Parameters<RuntimePluginEntrypointFactory>[0],
  ReturnType<RuntimePluginEntrypointFactory>
>("document-reader");
afterEach(removePortablePluginFixtures);

describe.each([
  ["source", createSource],
  ["bundle", createBundle],
] as const)("document reader platform contract (%s)", (_name, create) => {
  async function fixture() {
    const context = await createPortablePluginFixture("document-reader");
    await mkdir(context.runtimePaths.agentWorkDir);
    await mkdir(context.runtimePaths.workspaceDir);
    await mkdir(context.runtimePaths.attachmentsDir);
    return {
      context,
      root: context.runtimePaths.agentWorkDir,
      read: create(context).handlers.document_reader!,
    };
  }

  test.each(DOCUMENT_FORMATS)(
    "extracts %s with the packaged parser",
    async (format) => {
      const { root, read } = await fixture();
      const { bytes, expected } = await platformDocument(format);
      const path = join(root, "sample." + format);
      await writeFile(path, bytes);
      const result = await read({ source: "sample." + format });
      expect(result).toMatchObject({
        ok: true,
        data: { sourceKind: "runtime_path", location: "agent_work" },
      });
      expect(result.output).toContain(expected);
      expect(JSON.stringify(result)).not.toContain(
        JSON.stringify(root).slice(1, -1),
      );
      const expectedBytes = Buffer.from(bytes);
      expect((await readFile(path)).equals(expectedBytes)).toBe(true);
    },
    30_000,
  );

  test.each(["relative", "backslashes", "absolute"] as const)(
    "reads %s paths with Unicode, spaces and CRLF",
    async (form) => {
      const { root, read } = await fixture();
      await mkdir(join(root, "text files"));
      const path = join(root, "text files", "שלום.txt");
      await writeFile(path, "שלום\r\nsecond line");
      const inputs = {
        relative: "text files/שלום.txt",
        backslashes: "text files\\שלום.txt",
        absolute: path,
      };
      const result = await read({
        source_mode: "working_path",
        path: inputs[form],
      });
      expect(result).toMatchObject({
        ok: true,
        data: { path: "text files/שלום.txt" },
      });
      expect(result.output).toContain("שלום\r\nsecond line");
    },
    20_000,
  );

  test("reads only request-owned attachments without exposing storage paths", async () => {
    const { context, read } = await fixture();
    const absolutePath = join(context.runtimePaths.attachmentsDir, "opaque-id");
    await writeFile(absolutePath, "Attachment body");
    const attachment = {
      id: "att-one",
      kind: "file" as const,
      name: "report.md",
      mimeType: "text/markdown",
      absolutePath,
    };
    const result = await read(
      { source: "att-one" },
      { sharedState: { requestAttachments: [attachment] } },
    );
    expect(result).toMatchObject({
      ok: true,
      data: { sourceKind: "attachment", attachmentId: "att-one" },
    });
    expect(result.output).toContain("Attachment body");
    expect(JSON.stringify(result)).not.toContain(
      JSON.stringify(absolutePath).slice(1, -1),
    );
    const outside = join(context.rootDir, "outside.md");
    await writeFile(outside, "PRIVATE_OUTSIDE_CONTENT");
    const refused = await read(
      { source: "att-one" },
      {
        sharedState: {
          requestAttachments: [{ ...attachment, absolutePath: outside }],
        },
      },
    );
    expect(refused).toMatchObject({
      ok: false,
      errorCode: "document_outside_root",
    });
    expect(refused.output).not.toContain("PRIVATE_OUTSIDE_CONTENT");
  }, 20_000);

  test("preserves configured workspace and request resolver authority", async () => {
    const { context, root, read } = await fixture();
    await writeFile(
      join(context.runtimePaths.workspaceDir, "report.txt"),
      "Workspace body",
    );
    expect((await read({ source: "workspace/report.txt" })).output).toContain(
      "Workspace body",
    );
    const requestRoot = join(context.rootDir, "request");
    await mkdir(requestRoot);
    await writeFile(join(requestRoot, "report.txt"), "Request body");
    expect(
      (
        await read(
          { source: "report.txt" },
          {
            runtimePathResolver: createRuntimeToolPathResolver({
              ...context.runtimePaths,
              agentWorkDir: requestRoot,
            }),
          },
        )
      ).output,
    ).toContain("Request body");
    await symlink(
      requestRoot,
      join(root, "redirect"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const source of [
      "../request/report.txt",
      "redirect/report.txt",
      join(requestRoot, "report.txt"),
    ]) {
      const result = await read({ source });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toMatch(/^runtime_tool_path_/);
    }
  }, 30_000);

  test("enforces file size and output windows", async () => {
    const { root, read } = await fixture();
    const large = join(root, "large.txt");
    await writeFile(large, "");
    await truncate(large, 10 * 1024 * 1024 + 1);
    expect(await read({ source: "large.txt" })).toMatchObject({
      ok: false,
      errorCode: "document_file_too_large",
    });
    await writeFile(join(root, "window.txt"), "a".repeat(1500));
    expect(await read({ source: "window.txt", max_chars: 1000 })).toMatchObject(
      {
        ok: true,
        data: {
          totalCharacters: 1500,
          startChar: 0,
          endChar: 1000,
          truncated: true,
        },
      },
    );
  }, 30_000);

  test("cancels before reading the source", async () => {
    const { root, read } = await fixture();
    await writeFile(join(root, "cancel.txt"), "body");
    const controller = new AbortController();
    controller.abort();
    expect(
      await read({ source: "cancel.txt" }, { abortSignal: controller.signal }),
    ).toMatchObject({
      ok: false,
      errorCode: "document_read_cancelled",
    });
  });
});
