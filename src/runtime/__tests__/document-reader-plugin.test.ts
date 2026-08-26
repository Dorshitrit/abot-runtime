import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import { afterEach, describe, expect, test } from "vitest";

import createDocumentReaderPlugin from "../../../plugins/document-reader/source/index.js";
import type {
  RuntimePluginLoadContext,
  ToolExecutionContext,
} from "../../plugin-sdk/index.js";
import { PLUGIN_RESULT_SERIALIZED_MAX_BYTES } from "../../plugin-sdk/index.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";

const temporaryRoots: string[] = [];
const documentReaderEntrypoint = fileURLToPath(
  new URL("../../../plugins/document-reader/src/index.cjs", import.meta.url),
);

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "document-reader-plugin-"));
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
    [
      runtimePaths.runtimeDir,
      runtimePaths.agentWorkDir,
      runtimePaths.sessionsDir,
      runtimePaths.attachmentsDir,
      runtimePaths.workspaceDir,
      runtimePaths.sharedDir,
      runtimePaths.compiledDir,
      join(runtimePaths.runtimeDir, "logs"),
    ].map((directory) => mkdir(directory, { recursive: true })),
  );
  const runtimePathResolver = createRuntimeToolPathResolver(runtimePaths);
  const loadContext = {
    id: "document-reader",
    path: documentReaderEntrypoint,
    stateDir: join(runtimePaths.runtimeDir, "plugins", "document-reader"),
    rootDir: root,
    runtimeId: "test-runtime",
    agentBridgeUrl: "ws://127.0.0.1/unused",
    runtimePaths,
    runtimePathResolver,
    pluginRoot: join(root, "plugins", "document-reader"),
  } satisfies RuntimePluginLoadContext & Readonly<{ pluginRoot: string }>;
  const executionContext = {
    runtimePathResolver,
    sharedState: { runtimePaths },
  } satisfies ToolExecutionContext;
  return { root, runtimePaths, loadContext, executionContext };
}

function handlerFor(fixture: Fixture) {
  return createDocumentReaderPlugin(fixture.loadContext).handlers
    .document_reader;
}

async function zipBytes(files: Readonly<Record<string, string>>) {
  const zip = new JSZip();
  for (const [name, contents] of Object.entries(files)) {
    zip.file(name, contents);
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function minimalPdf(text: string): Buffer {
  const escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("document-reader plugin", () => {
  test("returns logical runtime paths and explicit window bounds", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.runtimePaths.agentWorkDir, "long.txt"),
      "a".repeat(2_500),
      "utf8",
    );

    const result = await handlerFor(fixture)(
      { source: "long.txt", max_chars: 1_000 },
      fixture.executionContext,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        sourceKind: "runtime_path",
        location: "agent_work",
        path: "long.txt",
        eventMeta: { path: "long.txt" },
        inputBytes: 2_500,
        totalCharacters: 2_500,
        startChar: 0,
        endChar: 1_000,
        truncated: true,
        truncation: {
          extractedText: { truncated: false, totalCharacters: 2_500 },
          window: { truncated: true, returnedCharacters: 1_000 },
          output: { truncated: false },
        },
      },
      actions: [{ target: "long.txt" }],
    });
    expect(result.output).toContain("Path: long.txt");
    expect(result.output).toContain("Next start_char: 1000");
    expect(JSON.stringify(result)).not.toContain(fixture.root);
  });

  test("caps retained extracted text while preserving an exact pagination total", async () => {
    const fixture = await createFixture();
    const retainedLimit = 10_040_000;
    const totalCharacters = retainedLimit + 100;
    await writeFile(
      join(fixture.runtimePaths.agentWorkDir, "bounded.txt"),
      "b".repeat(totalCharacters),
      "utf8",
    );

    const result = await handlerFor(fixture)(
      {
        source: "bounded.txt",
        start_char: 10_000_000,
        max_chars: 40_000,
      },
      fixture.executionContext,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        totalCharacters,
        startChar: 10_000_000,
        endChar: retainedLimit,
        truncated: true,
        truncation: {
          extractedText: {
            truncated: true,
            totalCharacters,
            returnedCharacters: retainedLimit,
            omittedCharacters: 100,
            maxCharacters: retainedLimit,
          },
        },
      },
    });
    expect(result.output).toContain(
      `Coverage: characters 10000000-${retainedLimit} of ${totalCharacters} (partial)`,
    );
    expect(result.output).toContain(`Next start_char: ${retainedLimit}`);
  });

  test("bounds multibyte document output by serialized bytes", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.runtimePaths.agentWorkDir, "unicode.txt"),
      "🧪".repeat(40_000),
      "utf8",
    );

    const result = await handlerFor(fixture)(
      { source: "unicode.txt", max_chars: 40_000 },
      fixture.executionContext,
    );

    expect(result).toMatchObject({ ok: true, data: { truncated: true } });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
      PLUGIN_RESULT_SERIALIZED_MAX_BYTES,
    );
    expect(result.output).toContain("Next start_char:");
  });

  test("resolves attachments by id or name without exposing their storage path", async () => {
    const fixture = await createFixture();
    const absolutePath = join(
      fixture.runtimePaths.attachmentsDir,
      "opaque-storage-id",
    );
    await writeFile(absolutePath, "Attachment body", "utf8");
    const executionContext = {
      ...fixture.executionContext,
      sharedState: {
        ...fixture.executionContext.sharedState,
        requestAttachments: [
          {
            id: "att-brief",
            kind: "file" as const,
            mimeType: "application/octet-stream",
            absolutePath,
            name: "brief.md",
          },
        ],
      },
    } satisfies ToolExecutionContext;
    const handler = handlerFor(fixture);

    for (const source of ["att-brief", "brief.md"]) {
      const result = await handler({ source }, executionContext);
      expect(result).toMatchObject({
        ok: true,
        data: {
          sourceKind: "attachment",
          attachmentId: "att-brief",
          mimeType: "text/markdown",
        },
        actions: [{ target: "attachment:att-brief" }],
      });
      expect(result.output).toContain("Attachment body");
      expect(result.output).toContain("Attachment id: att-brief");
      expect(result).not.toHaveProperty("data.eventMeta");
      expect(JSON.stringify(result)).not.toContain(absolutePath);
    }

    const ambiguous = await handler(
      { source: "brief.md" },
      {
        ...executionContext,
        sharedState: {
          ...executionContext.sharedState,
          requestAttachments: [
            ...executionContext.sharedState.requestAttachments,
            {
              id: "att-duplicate",
              kind: "file" as const,
              mimeType: "text/markdown",
              absolutePath,
              name: "brief.md",
            },
          ],
        },
      },
    );
    expect(ambiguous).toMatchObject({
      ok: false,
      errorCode: "document_attachment_ambiguous",
    });
    expect(JSON.stringify(ambiguous)).not.toContain(absolutePath);
  });

  test("keeps source and working_path authoritative and preserves canonical path errors", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.runtimePaths.agentWorkDir, "report.txt"),
      "Working path body",
      "utf8",
    );
    const attachmentPath = join(
      fixture.runtimePaths.attachmentsDir,
      "attachment-report",
    );
    await writeFile(attachmentPath, "Attachment body", "utf8");
    const executionContext = {
      ...fixture.executionContext,
      sharedState: {
        ...fixture.executionContext.sharedState,
        requestAttachments: [
          {
            id: "att-report",
            kind: "file" as const,
            mimeType: "text/plain",
            absolutePath: attachmentPath,
            name: "report.txt",
          },
        ],
      },
    } satisfies ToolExecutionContext;
    const handler = handlerFor(fixture);

    const source = await handler(
      { source_mode: "source", source: "att-report", path: "report.txt" },
      executionContext,
    );
    expect(source.output).toContain("Attachment body");
    expect(source.output).not.toContain("Working path body");

    const workingPath = await handler(
      {
        source_mode: "working_path",
        source: "att-report",
        path: "report.txt",
      },
      executionContext,
    );
    expect(workingPath.output).toContain("Working path body");
    expect(workingPath.output).not.toContain("Attachment body");

    await expect(
      handler(
        { source_mode: "working_path", path: "../outside.txt" },
        executionContext,
      ),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "runtime_tool_path_outside_configured_roots",
      error: "runtime_tool_path_outside_configured_roots",
    });
  });

  test("extracts every supported text and OOXML format", async () => {
    const fixture = await createFixture();
    const documents: ReadonlyArray<
      readonly [string, string | Uint8Array, string]
    > = [
      ["plain.txt", "Plain body", "Plain body"],
      ["notes.md", "# Markdown body", "Markdown body"],
      ["rows.csv", "name,value\nalpha,1", "alpha,1"],
      ["data.json", '{"ready":true}', '"ready": true'],
      ["legacy.rtf", "{\\rtf1 RTF body}", "RTF body"],
      [
        "word.docx",
        await zipBytes({
          "word/document.xml":
            '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Word body</w:t></w:r></w:p></w:body></w:document>',
        }),
        "Word body",
      ],
      [
        "slides.pptx",
        await zipBytes({
          "ppt/slides/slide1.xml":
            '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Slide body</a:t></p:sld>',
        }),
        "Slide body",
      ],
      [
        "sheet.xlsx",
        await zipBytes({
          "xl/sharedStrings.xml": "<sst><si><t>Cell body</t></si></sst>",
          "xl/worksheets/sheet1.xml":
            '<worksheet><row><c t="s"><v>0</v></c></row></worksheet>',
        }),
        "Cell body",
      ],
      ["paper.pdf", minimalPdf("PDF body"), "PDF body"],
    ];
    const handler = handlerFor(fixture);
    for (const [name, contents, expected] of documents) {
      await writeFile(join(fixture.runtimePaths.agentWorkDir, name), contents);
      const result = await handler({ source: name }, fixture.executionContext);
      expect(result, name).toMatchObject({ ok: true });
      expect(result.output, name).toContain(expected);
      expect(JSON.stringify(result), name).not.toContain(fixture.root);
      const extraction = result.data?.extraction as
        | { kind: string; archive?: { limits?: Record<string, number> } }
        | undefined;
      if (/\.(?:docx|pptx|xlsx)$/u.test(name)) {
        expect(extraction, name).toMatchObject({
          kind: "archive",
          archive: {
            processedXmlEntries: expect.any(Number),
            expandedXmlBytes: expect.any(Number),
            limits: {
              maxEntries: 4_096,
              maxXmlEntryBytes: 8 * 1024 * 1024,
              maxExpandedXmlBytes: 24 * 1024 * 1024,
            },
          },
        });
      } else if (name.endsWith(".pdf")) {
        expect(extraction, name).toMatchObject({
          kind: "pdf",
          totalPages: 1,
          processedPages: 1,
        });
      } else {
        expect(extraction, name).toEqual({ kind: "text" });
      }
    }
  });

  test("reports archive and input bounds without leaking filesystem errors", async () => {
    const fixture = await createFixture();
    const oversizedArchive = await zipBytes({
      "word/document.xml": "x".repeat(8 * 1024 * 1024 + 1),
    });
    await writeFile(
      join(fixture.runtimePaths.agentWorkDir, "oversized.docx"),
      oversizedArchive,
    );
    const tooLargePath = join(fixture.runtimePaths.agentWorkDir, "large.txt");
    await writeFile(tooLargePath, "");
    await truncate(tooLargePath, 10 * 1024 * 1024 + 1);
    const handler = handlerFor(fixture);

    const archive = await handler(
      { source: "oversized.docx" },
      fixture.executionContext,
    );
    expect(archive).toMatchObject({
      ok: false,
      errorCode: "document_archive_expansion_limit",
    });

    const input = await handler(
      { source: "large.txt" },
      fixture.executionContext,
    );
    expect(input).toMatchObject({
      ok: false,
      errorCode: "document_file_too_large",
    });

    const missing = await handler(
      { source: "missing.txt" },
      fixture.executionContext,
    );
    expect(missing).toMatchObject({
      ok: false,
      errorCode: "document_not_found",
    });
    expect(JSON.stringify([archive, input, missing])).not.toContain(
      fixture.root,
    );
  });
});
