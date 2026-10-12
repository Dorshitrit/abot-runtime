import type { PdfParserInput, PdfWorkerMessage } from "./pdf-contract.js";
import type { runPdfParser } from "./pdf-parser.js";

export const PDF_PROCESS_HEADER_MAX_BYTES = 64 * 1024;

// Serialized into a fresh Node process; no imports from the host are evaluated there.
export async function pdfProcessMain(
  parse: typeof runPdfParser,
  maxInputBytes: number,
  maxHeaderBytes: number,
  maxHeapBytes: number,
): Promise<void> {
  // Parser diagnostics are not part of the result protocol or user-visible evidence.
  console.log = console.warn = console.error = () => undefined;
  try {
    const { heap_size_limit } = require("node:v8").getHeapStatistics();
    if (heap_size_limit > maxHeapBytes) {
      const failure: PdfWorkerMessage = {
        kind: "failure",
        code: "document_pdf_resource_limit",
        message: "PDF extraction could not establish its memory limit.",
      };
      process.stdout.end(JSON.stringify(failure), () => process.exit(0));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > maxInputBytes + maxHeaderBytes + 1) {
        throw new Error("PDF process input exceeds its limit.");
      }
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks, size);
    const separator = input.indexOf(10);
    if (separator < 0) throw new Error("Missing PDF process header.");
    if (separator > maxHeaderBytes)
      throw new Error("PDF process header is too large.");
    const bytes = input.subarray(separator + 1);
    if (bytes.length > maxInputBytes)
      throw new Error("PDF process input is too large.");
    const header = JSON.parse(
      input.subarray(0, separator).toString("utf8"),
    ) as Omit<PdfParserInput, "bytes">;
    let result: PdfWorkerMessage | undefined;
    await parse({ ...header, bytes }, (message) => {
      result = message;
    });
    if (!result) throw new Error("PDF parser returned no result.");
    process.stdout.end(JSON.stringify(result), () => process.exit(0));
  } catch {
    // The parent reports a bounded failure; document bytes and native diagnostics stay private.
    process.exit(1);
  }
}
