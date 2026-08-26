import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, describe, expect, test } from "vitest";

import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";

import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";

const rootDir = process.cwd();
const temporaryRoots: string[] = [];

type Handler = (
  params: Record<string, unknown>,
  context?: Readonly<Record<string, unknown>>,
) => Promise<Record<string, unknown>>;

function loadManifest(pluginName: string) {
  const raw = JSON.parse(
    readFileSync(join(rootDir, "plugins", pluginName, "plugin.json"), "utf-8"),
  ) as unknown;
  return parseAgentPluginManifest(raw, pluginName);
}

function loadEntrypoint(pluginName: string) {
  return loadBundledPluginEntrypoint<
    Readonly<Record<string, unknown>>,
    Readonly<{ handlers: Readonly<Record<string, Handler>> }>
  >(pluginName);
}

function documentReaderLoadContext(
  input?: Readonly<{
    attachmentsDir: string;
    runtimePathResolver?: ReturnType<typeof createRuntimeToolPathResolver>;
  }>,
) {
  return {
    path: join(rootDir, "plugins", "document-reader", "src", "index.cjs"),
    runtimePaths: { attachmentsDir: input?.attachmentsDir ?? rootDir },
    ...(input?.runtimePathResolver
      ? { runtimePathResolver: input.runtimePathResolver }
      : {}),
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "read-only-plugin-parity-"));
  const agentWorkDir = join(root, "agent-work");
  const workspaceDir = join(root, "workspace");
  const attachmentsDir = join(root, "attachments");
  await Promise.all(
    [agentWorkDir, workspaceDir, attachmentsDir].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  temporaryRoots.push(root);
  return {
    root,
    agentWorkDir,
    workspaceDir,
    attachmentsDir,
    context: {
      sharedState: { runtimePaths: { agentWorkDir, workspaceDir } },
      runtimePathResolver: createRuntimeToolPathResolver({
        agentWorkDir,
        workspaceDir,
      }),
    },
  };
}

async function zipBytes(files: Record<string, string>) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array" });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("read-only Agent Plugins parity", () => {
  test("local-search declares its bounded read-only contract", () => {
    const manifest = loadManifest("local-search");
    const extension = manifest.extensions[ABOT_RUNTIME_EXTENSION];

    expect(extension.capabilities.local_search).toMatchObject({
      routingCapability: "filesystem_inspection",
      developmentRoles: ["inspect"],
      runtimePathBindings: [
        {
          operationId: "search_local_files",
          param: "path",
          base: "worker_working_directory",
          default: ".",
        },
      ],
      skills: ["local_search_skill"],
      operations: {
        search_local_files: {
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string", minLength: 1, maxLength: 1024 },
              path: { type: "string", minLength: 0, maxLength: 4096 },
              mode: { type: "string", enum: ["names", "content", "both"] },
              case_sensitive: { type: "boolean" },
              max_results: { type: "integer", minimum: 1, maximum: 200 },
            },
            required: ["query"],
          },
          effect: "read_only",
          approval: "request_policy",
        },
      },
    });
    expect(extension.capabilities.local_search.description).toEqual(
      expect.any(String),
    );
    expect(
      extension.capabilities.local_search.operations.search_local_files.summary,
    ).toEqual(expect.any(String));
    const entrypoint = loadEntrypoint("local-search")({
      runtimePathResolver: createRuntimeToolPathResolver({
        agentWorkDir: rootDir,
        workspaceDir: rootDir,
      }),
    });
    expect(Object.keys(entrypoint)).toEqual(["handlers"]);
    expect(Object.keys(entrypoint.handlers)).toEqual(["local_search"]);
  });

  test("document-reader declares its bounded read-only contract", () => {
    const manifest = loadManifest("document-reader");
    const extension = manifest.extensions[ABOT_RUNTIME_EXTENSION];

    expect(extension.capabilities.document_reader).toMatchObject({
      routingCapability: "filesystem_inspection",
      developmentRoles: ["inspect", "verify"],
      runtimePathBindings: [
        {
          operationId: "read_document",
          param: "path",
          base: "worker_working_directory",
          default: ".",
        },
      ],
      skills: ["document_reader_skill"],
      operations: {
        read_document: {
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              source_mode: {
                type: "string",
                enum: ["source", "working_path"],
              },
              source: { type: "string", minLength: 1, maxLength: 4096 },
              path: { type: "string", minLength: 1, maxLength: 4096 },
              start_char: { type: "integer", minimum: 0, maximum: 10000000 },
              max_chars: { type: "integer", minimum: 1000, maximum: 40000 },
            },
            required: [],
          },
          effect: "read_only",
          approval: "request_policy",
        },
      },
    });
    expect(extension.capabilities.document_reader.description).toEqual(
      expect.any(String),
    );
    expect(
      extension.capabilities.document_reader.operations.read_document.summary,
    ).toEqual(expect.any(String));
    const entrypoint = loadEntrypoint("document-reader")(
      documentReaderLoadContext(),
    );
    expect(Object.keys(entrypoint)).toEqual(["handlers"]);
    expect(Object.keys(entrypoint.handlers)).toEqual(["document_reader"]);
  });

  test("local-search resolves relative and workspace paths from configured roots", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.agentWorkDir, "src"));
    await writeFile(
      join(fixture.agentWorkDir, "src", "invoice-service.ts"),
      "export const invoiceStatus = 'ready';\n",
      "utf-8",
    );
    await writeFile(
      join(fixture.agentWorkDir, "src", "report:2026:final.txt"),
      "colon-path-token: detail:2026:kept\n",
      "utf-8",
    );
    await writeFile(
      join(fixture.agentWorkDir, "src", "line\nbreak.txt"),
      "newline-path-token\n",
      "utf-8",
    );
    await writeFile(
      join(fixture.agentWorkDir, "src", "-dash-file.txt"),
      "dash-path-token\n",
      "utf-8",
    );
    await writeFile(
      join(fixture.workspaceDir, "architecture.md"),
      "bounded context contract\n",
      "utf-8",
    );
    const handler = loadEntrypoint("local-search")(fixture.context).handlers
      .local_search;

    const rootSearch = await handler?.(
      { query: "invoice", mode: "both", max_results: 10 },
      fixture.context,
    );
    expect(rootSearch).toMatchObject({
      ok: true,
      producedNewInformation: true,
      data: {
        hasData: true,
        mode: "both",
        observationMeta: {
          kind: "volatile_external",
          carryPolicy: "never",
        },
      },
      actions: [{ type: "inspect_target", target: "." }],
    });
    expect(rootSearch?.output).toContain(
      'Search scope: selected logical path; use "." for the current Worker root.',
    );
    expect(rootSearch?.output).not.toContain("Search root:");
    expect(rootSearch?.output).toContain("- src/invoice-service.ts");
    expect(rootSearch?.output).toContain(
      "- src/invoice-service.ts:1:export const invoiceStatus = 'ready';",
    );
    expect(JSON.stringify(rootSearch)).not.toContain(fixture.agentWorkDir);

    const relative = await handler?.(
      { query: "invoice", path: "src", mode: "names" },
      fixture.context,
    );
    expect(relative).toMatchObject({
      ok: true,
      data: { hasData: true, itemCount: 1, mode: "names" },
      actions: [{ type: "inspect_target", target: "src" }],
    });
    expect(relative?.output).not.toContain("Search root: src");
    expect(relative?.output).toContain("- src/invoice-service.ts");
    expect(relative?.output).not.toContain("- ./invoice-service.ts");
    expect(JSON.stringify(relative)).not.toContain(fixture.agentWorkDir);

    const colonDirectory = await handler?.(
      { query: "colon-path-token", path: "src", mode: "content" },
      fixture.context,
    );
    expect(colonDirectory).toMatchObject({
      ok: true,
      data: { hasData: true, itemCount: 1, mode: "content" },
    });
    expect(colonDirectory?.output).toContain(
      "- src/report:2026:final.txt:1:colon-path-token: detail:2026:kept",
    );

    const colonFile = await handler?.(
      {
        query: "colon-path-token",
        path: "src/report:2026:final.txt",
        mode: "content",
      },
      fixture.context,
    );
    expect(colonFile).toMatchObject({
      ok: true,
      data: { hasData: true, itemCount: 1, mode: "content" },
    });
    expect(colonFile?.output).toContain(
      "- src/report:2026:final.txt:1:colon-path-token: detail:2026:kept",
    );
    expect(colonFile?.output).not.toContain(
      "report:2026:final.txt:2026:final.txt",
    );

    const newlineContent = await handler?.(
      { query: "newline-path-token", path: "src", mode: "content" },
      fixture.context,
    );
    expect(newlineContent).toMatchObject({
      ok: true,
      data: { hasData: true, itemCount: 1, mode: "content" },
    });
    expect(newlineContent?.output).toContain(
      "- src/line\\nbreak.txt:1:newline-path-token",
    );
    expect(newlineContent?.output).not.toContain("src/line\nbreak.txt");

    const newlineName = await handler?.(
      { query: "break", path: "src", mode: "names" },
      fixture.context,
    );
    expect(newlineName).toMatchObject({
      ok: true,
      data: { hasData: true, itemCount: 1, mode: "names" },
    });
    expect(newlineName?.output).toContain("- src/line\\nbreak.txt");
    expect(newlineName?.output).not.toContain("src/line\nbreak.txt");

    const leadingDashName = await handler?.(
      {
        query: "dash-file",
        path: "src/-dash-file.txt",
        mode: "names",
      },
      fixture.context,
    );
    expect(leadingDashName).toMatchObject({
      ok: true,
      data: { hasData: true, itemCount: 1, mode: "names" },
    });
    expect(leadingDashName?.output).toContain("- src/-dash-file.txt");
    expect(JSON.stringify(colonDirectory)).not.toContain(fixture.agentWorkDir);
    expect(JSON.stringify(colonFile)).not.toContain(fixture.agentWorkDir);
    expect(JSON.stringify(newlineContent)).not.toContain(fixture.agentWorkDir);
    expect(JSON.stringify(newlineName)).not.toContain(fixture.agentWorkDir);
    expect(JSON.stringify(leadingDashName)).not.toContain(fixture.agentWorkDir);

    const workspace = await handler?.(
      { query: "bounded context", path: "workspace", mode: "content" },
      fixture.context,
    );
    expect(workspace).toMatchObject({
      ok: true,
      producedNewInformation: true,
      data: { hasData: true, itemCount: 1, mode: "content" },
      actions: [{ type: "inspect_target", target: "workspace" }],
    });
    expect(workspace?.output).not.toContain("Search root: workspace");
    expect(workspace?.output).toContain(
      "workspace/architecture.md:1:bounded context contract",
    );
    expect(workspace?.output).not.toContain(
      "- architecture.md:1:bounded context contract",
    );
    expect(JSON.stringify(workspace)).not.toContain(fixture.workspaceDir);
  });

  test("local-search qualifies matches under a named effective Worker scope exactly once", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.agentWorkDir, "Project"));
    await writeFile(
      join(fixture.agentWorkDir, "Project", "index.html"),
      "<main>worker scope</main>\n",
      "utf-8",
    );
    const handler = loadEntrypoint("local-search")(fixture.context).handlers
      .local_search;

    // A runtimePathBinding qualifies raw `.` under Worker WD=`Project` to the
    // effective plugin control `Project`. Matches retain that logical scope
    // exactly once, while the non-reusable search-root value remains omitted.
    const result = await handler?.(
      { query: "worker scope", path: "Project", mode: "content" },
      fixture.context,
    );

    expect(result).toMatchObject({
      ok: true,
      data: { hasData: true, itemCount: 1 },
      actions: [{ type: "inspect_target", target: "Project" }],
    });
    expect(result?.output).toContain(
      'Search scope: selected logical path; use "." for the current Worker root.',
    );
    expect(result?.output).not.toContain("Search root: Project");
    expect(result?.output).toContain(
      "Project/index.html:1:<main>worker scope</main>",
    );
    expect(result?.output).not.toContain("Project/Project/");
    expect(JSON.stringify(result?.output)).not.toContain(fixture.agentWorkDir);
  });

  test("local-search reports a missing logical root without leaking its physical resolution", async () => {
    const fixture = await createFixture();
    const handler = loadEntrypoint("local-search")(fixture.context).handlers
      .local_search;

    const result = await handler?.(
      { query: "invoice", path: "missing-root", mode: "both" },
      fixture.context,
    );

    expect(result).toMatchObject({
      ok: false,
      producedNewInformation: false,
      errorCode: "local_search_root_not_found",
    });
    expect(result?.output).toBe(
      "The selected logical search root does not exist.",
    );
    expect(JSON.stringify(result)).not.toContain(fixture.agentWorkDir);
  });

  test("local-search fails closed when ripgrep cannot represent a path as UTF-8 text", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    await mkdir(join(fixture.agentWorkDir, "src"));
    const invalidPath = Buffer.concat([
      Buffer.from(join(fixture.agentWorkDir, "src", "invalid-")),
      Buffer.from([0xff]),
    ]);
    await writeFile(invalidPath, "unsupported-encoding-token\n");
    const handler = loadEntrypoint("local-search")(fixture.context).handlers
      .local_search;

    const content = await handler?.(
      { query: "unsupported-encoding-token", path: "src", mode: "content" },
      fixture.context,
    );
    expect(content).toMatchObject({
      ok: false,
      errorCode: "local_search_result_encoding_unsupported",
    });
    expect(JSON.stringify(content)).not.toContain(fixture.agentWorkDir);

    const names = await handler?.(
      { query: "invalid", path: "src", mode: "names" },
      fixture.context,
    );
    expect(names).toMatchObject({
      ok: false,
      errorCode: "local_search_result_encoding_unsupported",
    });
    expect(JSON.stringify(names)).not.toContain(fixture.agentWorkDir);
  });

  test("local-search preserves exact reusable paths and rejects ambiguous aliases", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.agentWorkDir, "src"));
    await mkdir(join(fixture.agentWorkDir, "workspace"));
    await writeFile(
      join(fixture.agentWorkDir, "src", "internal space.txt"),
      "safe-roundtrip-token\n",
      "utf-8",
    );
    await writeFile(
      join(fixture.agentWorkDir, " leading-space.txt"),
      "leading-boundary-token\n",
      "utf-8",
    );
    await writeFile(
      join(fixture.agentWorkDir, "trailing-space.txt "),
      "trailing-boundary-token\n",
      "utf-8",
    );
    await writeFile(
      join(fixture.agentWorkDir, "workspace", "shadow.txt"),
      "reserved-workspace-token\n",
      "utf-8",
    );
    if (process.platform !== "win32") {
      await writeFile(
        join(fixture.agentWorkDir, "back\\slash.txt"),
        "backslash-token\n",
        "utf-8",
      );
    }
    const handler = loadEntrypoint("local-search")(fixture.context).handlers
      .local_search;

    const safe = await handler?.(
      { query: "safe-roundtrip-token", path: "src", mode: "content" },
      fixture.context,
    );
    expect(safe).toMatchObject({
      ok: true,
      data: { hasData: true, itemCount: 1 },
    });
    expect(safe?.output).toContain(
      "src/internal space.txt:1:safe-roundtrip-token",
    );

    const leadingBoundary = await handler?.(
      { query: "leading-boundary-token", path: ".", mode: "content" },
      fixture.context,
    );
    expect(leadingBoundary).toMatchObject({
      ok: true,
      data: { hasData: true, itemCount: 1 },
    });
    expect(leadingBoundary?.output).toContain(
      " leading-space.txt:1:leading-boundary-token",
    );

    const leadingActionTarget = await handler?.(
      {
        query: "leading-boundary-token",
        path: join(fixture.agentWorkDir, " leading-space.txt"),
        mode: "content",
      },
      fixture.context,
    );
    expect(leadingActionTarget).toMatchObject({
      ok: true,
      data: { hasData: true, itemCount: 1 },
    });

    const trailingActionTarget = await handler?.(
      {
        query: "trailing-boundary-token",
        path: join(fixture.agentWorkDir, "trailing-space.txt "),
        mode: "content",
      },
      fixture.context,
    );
    expect(trailingActionTarget).toMatchObject({
      ok: true,
      data: { hasData: true, itemCount: 1 },
    });

    const reservedWorkspace = await handler?.(
      { query: "reserved-workspace-token", path: ".", mode: "content" },
      fixture.context,
    );
    expect(reservedWorkspace).toMatchObject({
      ok: false,
      errorCode: "local_search_path_roundtrip_unsafe",
    });

    const reservedActionTarget = await handler?.(
      {
        query: "reserved-workspace-token",
        path: join(fixture.agentWorkDir, "workspace"),
        mode: "content",
      },
      fixture.context,
    );
    expect(reservedActionTarget).toMatchObject({
      ok: false,
      errorCode: "local_search_path_roundtrip_unsafe",
    });

    if (process.platform !== "win32") {
      const backslash = await handler?.(
        { query: "backslash-token", path: ".", mode: "content" },
        fixture.context,
      );
      expect(backslash).toMatchObject({
        ok: false,
        errorCode: "local_search_path_roundtrip_unsafe",
      });
      expect(JSON.stringify(backslash)).not.toContain(fixture.agentWorkDir);
    }

    for (const result of [
      safe,
      leadingBoundary,
      leadingActionTarget,
      trailingActionTarget,
      reservedWorkspace,
      reservedActionTarget,
    ]) {
      expect(JSON.stringify(result)).not.toContain(fixture.agentWorkDir);
    }
  });

  test("local-search caps output only between complete result entries", async () => {
    const fixture = await createFixture();
    const longDirectory = `long-${"p".repeat(170)}`;
    await mkdir(join(fixture.agentWorkDir, longDirectory));
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeFile(
          join(
            fixture.agentWorkDir,
            longDirectory,
            `entry-${String(index).padStart(2, "0")}-${"n".repeat(80)}.txt`,
          ),
          `long-output-token ${"x".repeat(1800)} ENTRY-END-😀\n`,
          "utf-8",
        ),
      ),
    );
    const handler = loadEntrypoint("local-search")(fixture.context).handlers
      .local_search;

    const result = await handler?.(
      {
        query: "long-output-token",
        path: longDirectory,
        mode: "content",
        max_results: 100,
      },
      fixture.context,
    );
    expect(result).toMatchObject({
      ok: true,
      data: { hasData: true, truncation: { truncated: true } },
    });
    const output = String(result?.output);
    const data = result?.data as {
      itemCount: number;
      truncation: { truncated: boolean; returnedItems: number };
    };
    const entries = output.split("\n").filter((line) => line.startsWith("- "));
    expect(data.itemCount).toBeGreaterThan(0);
    expect(data.itemCount).toBeLessThan(40);
    expect(entries).toHaveLength(data.itemCount);
    expect(entries.every((line) => line.endsWith("ENTRY-END-😀"))).toBe(true);
    expect(data.truncation.returnedItems).toBe(data.itemCount);
    expect(output).toContain(`Returned matches: ${data.itemCount} (bounded)`);
    expect(output).toContain("Additional matches were omitted.");
    expect(output).not.toContain("[output truncated]");
    expect(output.length).toBeLessThanOrEqual(32768);
    expect(JSON.stringify(result)).not.toContain(fixture.agentWorkDir);
  });

  test("read-only paths reject traversal and symlink escape", async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), "read-only-plugin-outside-"));
    temporaryRoots.push(outside);
    await writeFile(join(outside, "secret.txt"), "do not expose", "utf-8");
    await symlink(outside, join(fixture.agentWorkDir, "escape"), "dir");
    const search = loadEntrypoint("local-search")(fixture.context).handlers
      .local_search;
    const reader = loadEntrypoint("document-reader")(
      documentReaderLoadContext({
        attachmentsDir: fixture.attachmentsDir,
        runtimePathResolver: fixture.context.runtimePathResolver,
      }),
    ).handlers.document_reader;

    await expect(
      search?.({ query: "secret", path: "../outside" }, fixture.context),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "runtime_tool_path_outside_configured_roots",
    });
    const escaped = await reader?.(
      { source: "escape/secret.txt" },
      fixture.context,
    );
    expect(escaped).toMatchObject({
      ok: false,
      errorCode: "runtime_tool_path_symlink_escape",
    });
    expect(escaped?.output).not.toContain("do not expose");
  });

  test("document-reader preserves bounded text and attachment results", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.agentWorkDir, "long.txt"),
      "a".repeat(2500),
      "utf-8",
    );
    const attachmentPath = join(fixture.attachmentsDir, "brief.txt");
    await writeFile(attachmentPath, "Quarterly report ready", "utf-8");
    const handler = loadEntrypoint("document-reader")(
      documentReaderLoadContext({
        attachmentsDir: fixture.attachmentsDir,
        runtimePathResolver: fixture.context.runtimePathResolver,
      }),
    ).handlers.document_reader;
    const attachmentContext = {
      sharedState: {
        runtimePaths: {
          agentWorkDir: fixture.agentWorkDir,
          workspaceDir: fixture.workspaceDir,
        },
        requestAttachments: [
          {
            id: "att-report",
            kind: "file",
            mimeType: "text/plain",
            absolutePath: attachmentPath,
            name: "report.txt",
          },
        ],
      },
    };

    const bounded = await handler?.(
      { source: "long.txt", max_chars: 1000 },
      fixture.context,
    );
    expect(bounded).toMatchObject({
      ok: true,
      producedNewInformation: true,
      data: {
        mimeType: "text/plain",
        totalCharacters: 2500,
        startChar: 0,
        endChar: 1000,
        truncated: true,
      },
    });
    expect(bounded?.output).toContain(
      "Coverage: characters 0-1000 of 2500 (partial)",
    );
    expect(bounded?.output).toContain("Next start_char: 1000");

    const attachment = await handler?.(
      { source: "att-report" },
      attachmentContext,
    );
    expect(attachment).toMatchObject({
      ok: true,
      data: { attachmentId: "att-report", mimeType: "text/plain" },
    });
    expect(attachment?.output).toContain("Quarterly report ready");
    expect(attachment?.output).toContain("Attachment id: att-report");

    const attachmentByName = await handler?.(
      { source: "report.txt" },
      attachmentContext,
    );
    expect(attachmentByName).toMatchObject({
      ok: true,
      data: { attachmentId: "att-report", mimeType: "text/plain" },
    });
    expect(attachmentByName?.output).toContain("Quarterly report ready");
  });

  test("document-reader keeps source and working-path lanes authoritative", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.agentWorkDir, "report.txt"),
      "Configured-root report ready",
      "utf-8",
    );
    const attachmentPath = join(fixture.attachmentsDir, "brief.txt");
    await writeFile(attachmentPath, "Attachment report ready", "utf-8");
    const handler = loadEntrypoint("document-reader")(
      documentReaderLoadContext({
        attachmentsDir: fixture.attachmentsDir,
        runtimePathResolver: fixture.context.runtimePathResolver,
      }),
    ).handlers.document_reader;
    const context = {
      sharedState: {
        runtimePaths: {
          agentWorkDir: fixture.agentWorkDir,
          workspaceDir: fixture.workspaceDir,
        },
        requestAttachments: [
          {
            id: "att-report",
            kind: "file",
            mimeType: "text/plain",
            absolutePath: attachmentPath,
            name: "report.txt",
          },
        ],
      },
      runtimePathResolver: createRuntimeToolPathResolver({
        agentWorkDir: fixture.agentWorkDir,
        workspaceDir: fixture.workspaceDir,
      }),
    };

    const missingSource = await handler?.({ path: "report.txt" }, context);
    expect(missingSource).toMatchObject({
      ok: false,
      producedNewInformation: false,
      errorCode: "document_source_required",
    });

    const sourceLane = await handler?.(
      {
        source_mode: "source",
        source: "att-report",
        path: "report.txt",
      },
      context,
    );
    expect(sourceLane).toMatchObject({
      ok: true,
      data: { attachmentId: "att-report", mimeType: "text/plain" },
    });
    expect(sourceLane?.output).toContain("Attachment report ready");
    expect(sourceLane?.output).not.toContain("Configured-root report ready");

    const workingPathLane = await handler?.(
      {
        source_mode: "working_path",
        source: "att-report",
        path: "report.txt",
      },
      context,
    );
    expect(workingPathLane).toMatchObject({
      ok: true,
      data: { mimeType: "text/plain" },
    });
    expect(workingPathLane?.data).not.toHaveProperty("attachmentId");
    expect(workingPathLane?.output).toContain("Configured-root report ready");
    expect(workingPathLane?.output).not.toContain("Attachment report ready");

    const missingWorkingPath = await handler?.(
      { source_mode: "working_path", source: "att-report" },
      context,
    );
    expect(missingWorkingPath).toMatchObject({
      ok: false,
      producedNewInformation: false,
      errorCode: "document_path_required",
    });
  });

  test("document-reader working paths preserve configured path safety", async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), "document-reader-outside-"));
    temporaryRoots.push(outside);
    const agentDocument = join(fixture.agentWorkDir, "absolute.txt");
    await writeFile(agentDocument, "Absolute configured document", "utf-8");
    await writeFile(
      join(fixture.workspaceDir, "workspace.txt"),
      "Workspace configured document",
      "utf-8",
    );
    await writeFile(join(outside, "secret.txt"), "Outside secret", "utf-8");
    const handler = loadEntrypoint("document-reader")(
      documentReaderLoadContext({
        attachmentsDir: fixture.attachmentsDir,
        runtimePathResolver: fixture.context.runtimePathResolver,
      }),
    ).handlers.document_reader;

    const workspace = await handler?.(
      { source_mode: "working_path", path: "workspace/workspace.txt" },
      fixture.context,
    );
    expect(workspace).toMatchObject({ ok: true });
    expect(workspace?.output).toContain("Workspace configured document");

    const absolute = await handler?.(
      { source_mode: "working_path", path: agentDocument },
      fixture.context,
    );
    expect(absolute).toMatchObject({ ok: true });
    expect(absolute?.output).toContain("Absolute configured document");

    for (const path of ["../outside/secret.txt", join(outside, "secret.txt")]) {
      const rejected = await handler?.(
        { source_mode: "working_path", path },
        fixture.context,
      );
      expect(rejected).toMatchObject({
        ok: false,
        producedNewInformation: false,
        errorCode: "runtime_tool_path_outside_configured_roots",
      });
      expect(rejected?.output).not.toContain("Outside secret");
    }
  });

  test("document-reader owns working OOXML extraction", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.agentWorkDir, "sample.docx"),
      await zipBytes({
        "word/document.xml":
          '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Word summary</w:t></w:r></w:p></w:body></w:document>',
      }),
    );
    const handler = loadEntrypoint("document-reader")(
      documentReaderLoadContext({
        attachmentsDir: fixture.attachmentsDir,
        runtimePathResolver: fixture.context.runtimePathResolver,
      }),
    ).handlers.document_reader;
    const result = await handler?.({ source: "sample.docx" }, fixture.context);

    expect(result).toMatchObject({
      ok: true,
      producedNewInformation: true,
      data: {
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        hasData: true,
      },
    });
    expect(result?.output).toContain("Word summary");
  });
});
