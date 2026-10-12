import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { extractPdfInProcess } from "../../../plugins/document-reader/source/pdf-process.js";
import {
  PDF_EXTRACTION_LIMITS,
  type PdfExtractionLimits,
} from "../../../plugins/document-reader/source/pdf-contract.js";
import { platformDocument } from "./document-reader-platform-fixtures.js";

const roots: string[] = [];
const realParser = createRequire(import.meta.url).resolve("pdf-parse");
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fakeParser(
  getInfo: string,
  text = "bounded text",
): Promise<string> {
  const base = join(process.cwd(), ".codex/artifacts/pdf-process-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  roots.push(root);
  const path = join(root, "parser.cjs");
  await writeFile(
    path,
    "exports.PDFParse = class { async getInfo() { " +
      getInfo +
      " } async getText() { return { pages: [{ text: " +
      JSON.stringify(text) +
      " }] }; } async destroy() {} };",
  );
  return path;
}

function extract(
  entrypoint: string,
  limits: Partial<PdfExtractionLimits> = {},
  signal?: AbortSignal,
) {
  return extractPdfInProcess(Buffer.from("fixture"), {
    pdfParseEntrypoint: entrypoint,
    limits: { ...PDF_EXTRACTION_LIMITS, ...limits },
    ...(signal ? { signal } : {}),
  });
}

describe("document reader isolated PDF process", () => {
  test("repeated PDF parsing keeps the calling process alive", async () => {
    const { bytes, expected } = await platformDocument("pdf");
    for (let index = 0; index < 3; index++) {
      const result = await extractPdfInProcess(Buffer.from(bytes), {
        pdfParseEntrypoint: realParser,
      });
      expect(result.text).toContain(expected);
      expect(result.format).toMatchObject({
        kind: "pdf",
        totalPages: 1,
        processedPages: 1,
      });
    }
  }, 20_000);

  test("bounds retained text while preserving the full character count", async () => {
    const entrypoint = await fakeParser(
      "return { total: 1 };",
      "x".repeat(2000),
    );
    const result = await extract(entrypoint, { maxRetainedCharacters: 64 });
    expect(result.text).toBe("x".repeat(64));
    expect(result.textBounds).toMatchObject({
      totalCharacters: 2000,
      returnedCharacters: 64,
      omittedCharacters: 1936,
      truncated: true,
    });
  });

  test.each([
    ["return { total: 10001 };", "document_pdf_page_limit"],
    ["return { total: -1 };", "document_content_invalid"],
  ])("preserves parser failures (%s)", async (body, code) => {
    await expect(extract(await fakeParser(body))).rejects.toMatchObject({
      code,
    });
  });

  test("contains a parser process crash and permits a subsequent read", async () => {
    await expect(
      extract(await fakeParser("process.exit(73);")),
    ).rejects.toThrow("stopped unexpectedly");
    expect((await extract(await fakeParser("return { total: 1 };"))).text).toBe(
      "bounded text",
    );
  });

  test("returns an explicit failure when the parser process cannot start", async () => {
    const entrypoint = await fakeParser("return { total: 1 };");
    const executable = process.execPath;
    try {
      process.execPath = entrypoint + ".missing-executable";
      await expect(extract(entrypoint)).rejects.toMatchObject({
        code: "document_pdf_process_unavailable",
      });
    } finally {
      process.execPath = executable;
    }
  });

  test("cancels before launching a parser", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extract("missing-parser.cjs", {}, controller.signal),
    ).rejects.toMatchObject({ code: "document_read_cancelled" });
  });

  test("waits for a running parser to exit on cancellation", async () => {
    const entrypoint = await fakeParser(
      'require("node:fs").writeFileSync(__filename + ".pid", String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {});',
    );
    const controller = new AbortController();
    const outcome = extract(entrypoint, {}, controller.signal).catch(
      (error) => error,
    );
    let pid = 0;
    try {
      await vi.waitFor(
        async () => {
          pid = Number(await readFile(entrypoint + ".pid", "utf8"));
          expect(pid).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );
    } finally {
      controller.abort();
    }
    expect(await outcome).toMatchObject({ code: "document_read_cancelled" });
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  test("enforces the deadline even when the parser never responds", async () => {
    const entrypoint = await fakeParser(
      "setInterval(() => {}, 1000); await new Promise(() => {});",
    );
    await expect(extract(entrypoint, { timeoutMs: 50 })).rejects.toMatchObject({
      code: "document_pdf_resource_limit",
    });
  });

  test("enforces the input byte limit before parser startup", async () => {
    await expect(
      extractPdfInProcess(Buffer.alloc(10 * 1024 * 1024 + 1), {
        pdfParseEntrypoint: "missing-parser.cjs",
      }),
    ).rejects.toMatchObject({ code: "document_file_too_large" });
  });

  test("bounds malformed process output and discards it", async () => {
    const entrypoint = await fakeParser(
      'process.stdout.write("x".repeat(20000)); setInterval(() => {}, 1000); await new Promise(() => {});',
    );
    await expect(
      extract(entrypoint, { maxRetainedCharacters: 64 }),
    ).rejects.toMatchObject({
      code: "document_pdf_resource_limit",
    });
  });

  test("preserves operator-configured Node preloads", async () => {
    const entrypoint = await fakeParser("return { total: 1 };");
    vi.stubEnv(
      "NODE_OPTIONS",
      "--require " + JSON.stringify(entrypoint + ".missing"),
    );
    await expect(extract(entrypoint)).rejects.toThrow("stopped unexpectedly");
  });

  test("refuses extraction when V8 cannot honor the requested heap bound", async () => {
    const entrypoint = await fakeParser("return { total: 1 };");
    await expect(
      extract(entrypoint, { maxYoungGenerationSizeMb: 1 }),
    ).rejects.toMatchObject({
      code: "document_pdf_resource_limit",
    });
  });

  test("applies the heap limit inside the child process", async () => {
    vi.stubEnv(
      "NODE_OPTIONS",
      "--max-old-space-size=1024 --max-semi-space-size=64",
    );
    const entrypoint = await fakeParser("return { total: 1 };", "");
    await writeFile(
      entrypoint,
      'exports.PDFParse = class { async getInfo() { return { total: 1 }; } async getText() { return { pages: [{ text: String(require("node:v8").getHeapStatistics().heap_size_limit) }] }; } async destroy() {} };',
    );
    const result = await extract(entrypoint, {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 12,
    });
    const limit = Number(result.text);
    expect(limit).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    expect(limit).toBeLessThanOrEqual(76 * 1024 * 1024);
  });
});
