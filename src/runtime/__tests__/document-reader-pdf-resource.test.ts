import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import {
  createPdfExtractionWorker,
  extractPdfInWorker,
  PDF_EXTRACTION_LIMITS,
  type PdfExtractionLimits,
} from "../../../plugins/document-reader/source/pdf-worker.js";

const pdfParseEntrypoint = createRequire(import.meta.url).resolve("pdf-parse");

function compressedPdf(text: string): Buffer {
  const textOperations = Array.from(
    { length: Math.ceil(text.length / 64) },
    (_, index) => {
      const escaped = text
        .slice(index * 64, index * 64 + 64)
        .replaceAll("\\", "\\\\")
        .replaceAll("(", "\\(")
        .replaceAll(")", "\\)");
      return `1 0 0 1 72 720 Tm (${escaped}) Tj`;
    },
  ).join("\n");
  const compressed = deflateSync(
    Buffer.from(`BT /F1 12 Tf\n${textOperations}\nET`, "ascii"),
  );
  const objects: readonly (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    Buffer.concat([
      Buffer.from(
        `<< /Length ${compressed.byteLength} /Filter /FlateDecode >>\nstream\n`,
        "ascii",
      ),
      compressed,
      Buffer.from("\nendstream", "ascii"),
    ]),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  let byteLength = parts[0]?.byteLength ?? 0;
  const append = (value: string | Buffer): void => {
    const bytes =
      typeof value === "string" ? Buffer.from(value, "ascii") : value;
    parts.push(bytes);
    byteLength += bytes.byteLength;
  };
  for (const [index, object] of objects.entries()) {
    offsets.push(byteLength);
    append(`${index + 1} 0 obj\n`);
    append(object);
    append("\nendobj\n");
  }
  const xrefOffset = byteLength;
  append(`xref\n0 ${objects.length + 1}\n`);
  append("0000000000 65535 f \n");
  for (const offset of offsets.slice(1)) {
    append(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  append(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );
  return Buffer.concat(parts, byteLength);
}

function limits(overrides: Partial<PdfExtractionLimits>): PdfExtractionLimits {
  return Object.freeze({ ...PDF_EXTRACTION_LIMITS, ...overrides });
}

describe("document-reader PDF resource boundary", () => {
  test("starts the parser with finite heap and stack limits", async () => {
    const worker = createPdfExtractionWorker(
      compressedPdf("bounded worker"),
      pdfParseEntrypoint,
    );
    try {
      expect(worker.resourceLimits).toMatchObject({
        maxOldGenerationSizeMb: PDF_EXTRACTION_LIMITS.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb:
          PDF_EXTRACTION_LIMITS.maxYoungGenerationSizeMb,
        stackSizeMb: PDF_EXTRACTION_LIMITS.stackSizeMb,
      });
    } finally {
      await worker.terminate();
    }
  });

  test("returns only the bounded text window across the worker boundary", async () => {
    const retainedCharacters = 4_096;
    const totalCharacters = retainedCharacters + 2_048;
    const extracted = await extractPdfInWorker(
      compressedPdf("x".repeat(totalCharacters)),
      {
        pdfParseEntrypoint,
        limits: limits({ maxRetainedCharacters: retainedCharacters }),
      },
    );

    expect(extracted.text).toHaveLength(retainedCharacters);
    expect(extracted.textBounds).toEqual({
      truncated: true,
      totalCharacters: expect.any(Number),
      returnedCharacters: retainedCharacters,
      omittedCharacters: expect.any(Number),
      maxCharacters: retainedCharacters,
    });
    expect(extracted.textBounds.totalCharacters).toBeGreaterThan(
      retainedCharacters,
    );
    expect(extracted.textBounds.omittedCharacters).toBe(
      extracted.textBounds.totalCharacters - retainedCharacters,
    );
    expect(extracted.format).toEqual({
      kind: "pdf",
      totalPages: 1,
      processedPages: 1,
      maxPages: PDF_EXTRACTION_LIMITS.maxPages,
    });
  });

  test("terminates extraction when its deadline expires", async () => {
    await expect(
      extractPdfInWorker(compressedPdf("deadline"), {
        pdfParseEntrypoint,
        limits: limits({ timeoutMs: 1 }),
      }),
    ).rejects.toMatchObject({
      name: "DocumentReaderError",
      code: "document_pdf_resource_limit",
    });
  });
});
