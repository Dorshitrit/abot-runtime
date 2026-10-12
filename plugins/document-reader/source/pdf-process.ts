import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  MAX_DOCUMENT_BYTES,
  MAX_PDF_ERROR_MESSAGE_CHARS,
} from "./constants.js";
import { DocumentReaderError } from "./errors.js";
import {
  PDF_EXTRACTION_LIMITS,
  type PdfExtractionLimits,
} from "./pdf-contract.js";
import { runPdfParser } from "./pdf-parser.js";
import {
  PDF_PROCESS_HEADER_MAX_BYTES,
  pdfProcessMain,
} from "./pdf-process-main.js";
import { documentFromPdfMessage } from "./pdf-result.js";
import type { ExtractedDocument } from "./types.js";

function pdfSemiSpaceLimitMb(youngGenerationMb: number): number {
  // V8 rounds semi-spaces up to a power of two. Choose a lower power so its
  // three-space young generation stays within the declared memory budget.
  const maximum = Math.floor(youngGenerationMb / 3);
  let size = 1;
  while (size * 2 <= maximum) size *= 2;
  return size;
}

function pdfProcessArguments(limits: PdfExtractionLimits): string[] {
  return [
    "--input-type=commonjs",
    "--max-old-space-size=" + limits.maxOldGenerationSizeMb,
    // V8's young generation uses three semi-spaces; keep it within the existing bound.
    "--max-semi-space-size=" +
      pdfSemiSpaceLimitMb(limits.maxYoungGenerationSizeMb),
    "--stack-size=" + Math.floor(limits.stackSizeMb * 1024),
    "--eval",
    "(" +
      pdfProcessMain.toString() +
      ")(" +
      runPdfParser.toString() +
      ", " +
      MAX_DOCUMENT_BYTES +
      ", " +
      PDF_PROCESS_HEADER_MAX_BYTES +
      ", " +
      (limits.maxOldGenerationSizeMb + limits.maxYoungGenerationSizeMb) *
        1024 *
        1024 +
      ")",
  ];
}

export function createPdfExtractionProcess(
  bytes: Uint8Array,
  pdfParseEntrypoint: string,
  limits: PdfExtractionLimits,
): ChildProcessWithoutNullStreams {
  const header = Buffer.from(
    JSON.stringify({
      pdfParseEntrypoint,
      limits: {
        maxPages: limits.maxPages,
        pageBatchSize: limits.pageBatchSize,
        maxRetainedCharacters: limits.maxRetainedCharacters,
        maxErrorMessageCharacters: MAX_PDF_ERROR_MESSAGE_CHARS,
      },
    }) + "\n",
  );
  if (header.length > PDF_PROCESS_HEADER_MAX_BYTES) {
    throw new Error("PDF process header exceeds its limit.");
  }
  const child = spawn(process.execPath, pdfProcessArguments(limits), {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(header);
  child.stdin.end(Buffer.from(bytes));
  return child;
}

function pdfCancellationError(): DocumentReaderError {
  return new DocumentReaderError(
    "document_read_cancelled",
    "Document reading was cancelled.",
  );
}

function pdfResourceError(message: string): DocumentReaderError {
  return new DocumentReaderError("document_pdf_resource_limit", message);
}

function didPdfProcessExitCleanly(
  code: number | null,
  signal: NodeJS.Signals | null,
): boolean {
  if (signal !== null) return false;
  return code === 0;
}

export async function extractPdfInProcess(
  bytes: Uint8Array,
  params: Readonly<{
    pdfParseEntrypoint: string;
    signal?: AbortSignal;
    limits?: PdfExtractionLimits;
  }>,
): Promise<ExtractedDocument> {
  if (params.signal?.aborted) throw pdfCancellationError();
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentReaderError(
      "document_file_too_large",
      "The PDF exceeds the input size limit.",
    );
  }
  const limits = params.limits ?? PDF_EXTRACTION_LIMITS;
  const child = createPdfExtractionProcess(
    bytes,
    params.pdfParseEntrypoint,
    limits,
  );
  // A JSON string can use six bytes per UTF-16 code unit, plus fixed metadata.
  const maxResultBytes = limits.maxRetainedCharacters * 6 + 4096;
  return new Promise<ExtractedDocument>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let resultBytes = 0;
    let failure: Error | undefined;
    const stopPdfProcess = (error: Error): void => {
      if (failure) return;
      failure = error;
      chunks.length = 0;
      child.stdin.destroy();
      child.kill("SIGKILL");
    };
    const onAbort = (): void => stopPdfProcess(pdfCancellationError());
    const timeout = setTimeout(
      () =>
        stopPdfProcess(
          pdfResourceError(
            "PDF extraction exceeded the " +
              limits.timeoutMs +
              "-millisecond time limit.",
          ),
        ),
      limits.timeoutMs,
    );
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      resultBytes += chunk.length;
      if (resultBytes > maxResultBytes) {
        stopPdfProcess(
          pdfResourceError("PDF extraction exceeded its result size limit."),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () =>
      stopPdfProcess(
        new Error("PDF extraction process could not receive its input."),
      ),
    );
    child.stdout.on("error", () =>
      stopPdfProcess(
        new Error("PDF extraction process could not return its result."),
      ),
    );
    child.stderr.on("error", () =>
      stopPdfProcess(new Error("PDF extraction process stream failed.")),
    );
    child.on("error", () =>
      stopPdfProcess(
        new DocumentReaderError(
          "document_pdf_process_unavailable",
          "The PDF extraction process could not be started or stopped. Do not retry or bypass this restriction with another tool; ask the user to check system requirements or contact their administrator.",
        ),
      ),
    );
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      if (failure) {
        reject(failure);
        return;
      }
      if (!didPdfProcessExitCleanly(code, signal)) {
        reject(new Error("PDF extraction process stopped unexpectedly."));
        return;
      }
      try {
        const message: unknown = JSON.parse(
          Buffer.concat(chunks, resultBytes).toString("utf8"),
        );
        resolve(documentFromPdfMessage(message, limits));
      } catch (error) {
        if (error instanceof SyntaxError) {
          reject(new Error("PDF extraction process returned invalid data."));
          return;
        }
        reject(error);
      }
    });
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) onAbort();
  });
}
