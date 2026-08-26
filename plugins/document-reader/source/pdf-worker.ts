import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

import {
  MAX_PDF_ERROR_MESSAGE_CHARS,
  MAX_PDF_PAGES,
  MAX_RETAINED_TEXT_CHARS,
  PDF_EXTRACTION_TIMEOUT_MS,
  PDF_MAX_OLD_GENERATION_MB,
  PDF_MAX_STACK_MB,
  PDF_MAX_YOUNG_GENERATION_MB,
  PDF_PAGE_BATCH_SIZE,
} from "./constants.js";
import { DocumentReaderError } from "./errors.js";
import type { ExtractedDocument } from "./types.js";

export type PdfExtractionLimits = Readonly<{
  maxPages: number;
  pageBatchSize: number;
  maxRetainedCharacters: number;
  timeoutMs: number;
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  stackSizeMb: number;
}>;

export const PDF_EXTRACTION_LIMITS: PdfExtractionLimits = Object.freeze({
  maxPages: MAX_PDF_PAGES,
  pageBatchSize: PDF_PAGE_BATCH_SIZE,
  maxRetainedCharacters: MAX_RETAINED_TEXT_CHARS,
  timeoutMs: PDF_EXTRACTION_TIMEOUT_MS,
  maxOldGenerationSizeMb: PDF_MAX_OLD_GENERATION_MB,
  maxYoungGenerationSizeMb: PDF_MAX_YOUNG_GENERATION_MB,
  stackSizeMb: PDF_MAX_STACK_MB,
});

type PdfWorkerSuccess = Readonly<{
  kind: "success";
  text: string;
  totalCharacters: number;
  returnedCharacters: number;
  totalPages: number;
  processedPages: number;
}>;

type PdfWorkerFailure = Readonly<{
  kind: "failure";
  code?: string;
  message: string;
}>;

type PdfWorkerMessage = PdfWorkerSuccess | PdfWorkerFailure;

const CONTROLLED_PDF_ERROR_CODES = new Set([
  "document_content_invalid",
  "document_pdf_page_limit",
  "document_pdf_resource_limit",
]);

function pdfExtractionWorkerMain(): void {
  const { parentPort, workerData } =
    require("node:worker_threads") as typeof import("node:worker_threads");
  const data = workerData as {
    bytes: ArrayBuffer;
    pdfParseEntrypoint: string;
    limits: {
      maxPages: number;
      pageBatchSize: number;
      maxRetainedCharacters: number;
      maxErrorMessageCharacters: number;
    };
  };

  const fail = (code: string, message: string): never => {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    throw error;
  };

  const boundedMessage = (value: unknown): string => {
    const message = value instanceof Error ? value.message : String(value);
    return message.slice(0, data.limits.maxErrorMessageCharacters);
  };

  const run = async (): Promise<void> => {
    if (!parentPort) {
      throw new Error("PDF extraction worker has no parent port.");
    }
    let parser:
      | InstanceType<(typeof import("pdf-parse"))["PDFParse"]>
      | undefined;
    try {
      const { PDFParse } = require(
        data.pdfParseEntrypoint,
      ) as typeof import("pdf-parse");
      parser = new PDFParse({
        data: new Uint8Array(data.bytes),
        isEvalSupported: false,
        stopAtErrors: true,
      });
      const info = await parser.getInfo();
      const totalPages = info.total;
      if (!Number.isSafeInteger(totalPages) || totalPages < 0) {
        fail("document_content_invalid", "The PDF page index is invalid.");
      }
      if (totalPages > data.limits.maxPages) {
        fail(
          "document_pdf_page_limit",
          `The PDF exceeds the ${data.limits.maxPages}-page parsing limit.`,
        );
      }

      const retainedParts: string[] = [];
      let retainedCharacters = 0;
      let totalCharacters = 0;
      let processedPages = 0;
      let hasContent = false;

      const append = (rawValue: string): void => {
        const value = rawValue.replaceAll("\u0000", "").trim();
        if (value.length === 0) return;
        const separator = hasContent ? "\n\n" : "";
        hasContent = true;
        const nextTotal = totalCharacters + separator.length + value.length;
        if (!Number.isSafeInteger(nextTotal)) {
          fail(
            "document_pdf_resource_limit",
            "The PDF text exceeds the supported character range.",
          );
        }
        totalCharacters = nextTotal;
        let remaining = data.limits.maxRetainedCharacters - retainedCharacters;
        if (remaining <= 0) return;
        if (separator.length > 0) {
          const retainedSeparator = separator.slice(0, remaining);
          retainedParts.push(retainedSeparator);
          retainedCharacters += retainedSeparator.length;
          remaining -= retainedSeparator.length;
        }
        if (remaining > 0) {
          const retainedValue = value.slice(0, remaining);
          retainedParts.push(retainedValue);
          retainedCharacters += retainedValue.length;
        }
      };

      for (
        let firstPage = 1;
        firstPage <= totalPages;
        firstPage += data.limits.pageBatchSize
      ) {
        const pageNumbers = Array.from(
          {
            length: Math.min(
              data.limits.pageBatchSize,
              totalPages - firstPage + 1,
            ),
          },
          (_, index) => firstPage + index,
        );
        const batch = await parser.getText({
          partial: pageNumbers,
          pageJoiner: "",
        });
        if (!Array.isArray(batch.pages)) {
          fail(
            "document_content_invalid",
            "The PDF page set could not be extracted.",
          );
        }
        for (const page of batch.pages) {
          if (typeof page?.text !== "string") {
            fail("document_content_invalid", "The PDF page text is invalid.");
          }
          processedPages += 1;
          append(page.text);
        }
      }
      if (processedPages !== totalPages) {
        fail(
          "document_content_invalid",
          "The PDF page set could not be extracted completely.",
        );
      }
      parentPort.postMessage({
        kind: "success",
        text: retainedParts.join(""),
        totalCharacters,
        returnedCharacters: retainedCharacters,
        totalPages,
        processedPages,
      } satisfies PdfWorkerSuccess);
    } catch (error) {
      const candidateCode =
        error instanceof Error &&
        typeof (error as Error & { code?: unknown }).code === "string"
          ? (error as Error & { code: string }).code
          : undefined;
      parentPort.postMessage({
        kind: "failure",
        ...(candidateCode ? { code: candidateCode } : {}),
        message: boundedMessage(error),
      } satisfies PdfWorkerFailure);
    } finally {
      if (parser) {
        await parser.destroy().catch(() => undefined);
      }
      parentPort.close();
    }
  };

  void run();
}

export function resolvePdfParseEntrypoint(pluginEntrypoint: string): string {
  return createRequire(pluginEntrypoint).resolve("pdf-parse");
}

export function createPdfExtractionWorker(
  bytes: Uint8Array,
  pdfParseEntrypoint: string,
  limits: PdfExtractionLimits = PDF_EXTRACTION_LIMITS,
): Worker {
  const transferredBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(transferredBytes).set(bytes);
  return new Worker(`(${pdfExtractionWorkerMain.toString()})()`, {
    eval: true,
    transferList: [transferredBytes],
    workerData: {
      bytes: transferredBytes,
      pdfParseEntrypoint,
      limits: {
        maxPages: limits.maxPages,
        pageBatchSize: limits.pageBatchSize,
        maxRetainedCharacters: limits.maxRetainedCharacters,
        maxErrorMessageCharacters: MAX_PDF_ERROR_MESSAGE_CHARS,
      },
    },
    resourceLimits: {
      maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb,
      stackSizeMb: limits.stackSizeMb,
    },
  });
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isPdfWorkerMessage(value: unknown): value is PdfWorkerMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PdfWorkerMessage>;
  if (candidate.kind === "failure") {
    return (
      typeof candidate.message === "string" &&
      candidate.message.length <= MAX_PDF_ERROR_MESSAGE_CHARS &&
      (candidate.code === undefined || typeof candidate.code === "string")
    );
  }
  return (
    candidate.kind === "success" &&
    typeof candidate.text === "string" &&
    isSafeNonNegativeInteger(candidate.totalCharacters) &&
    isSafeNonNegativeInteger(candidate.returnedCharacters) &&
    isSafeNonNegativeInteger(candidate.totalPages) &&
    isSafeNonNegativeInteger(candidate.processedPages)
  );
}

function resourceLimitError(message: string): DocumentReaderError {
  return new DocumentReaderError("document_pdf_resource_limit", message);
}

export async function extractPdfInWorker(
  bytes: Uint8Array,
  params: Readonly<{
    pdfParseEntrypoint: string;
    signal?: AbortSignal;
    limits?: PdfExtractionLimits;
  }>,
): Promise<ExtractedDocument> {
  const limits = params.limits ?? PDF_EXTRACTION_LIMITS;
  if (params.signal?.aborted) {
    throw new DocumentReaderError(
      "document_read_cancelled",
      "Document reading was cancelled.",
    );
  }
  const worker = createPdfExtractionWorker(
    bytes,
    params.pdfParseEntrypoint,
    limits,
  );
  return new Promise<ExtractedDocument>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settle(
        () =>
          reject(
            resourceLimitError(
              `PDF extraction exceeded the ${limits.timeoutMs}-millisecond time limit.`,
            ),
          ),
        true,
      );
    }, limits.timeoutMs);
    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const settle = (complete: () => void, terminate: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) void worker.terminate();
      complete();
    };
    const onAbort = (): void => {
      settle(
        () =>
          reject(
            new DocumentReaderError(
              "document_read_cancelled",
              "Document reading was cancelled.",
            ),
          ),
        true,
      );
    };

    worker.once("message", (message: unknown) => {
      if (!isPdfWorkerMessage(message)) {
        settle(
          () =>
            reject(new Error("PDF extraction worker returned invalid data.")),
          true,
        );
        return;
      }
      if (message.kind === "failure") {
        settle(() => {
          if (message.code && CONTROLLED_PDF_ERROR_CODES.has(message.code)) {
            reject(new DocumentReaderError(message.code, message.message));
            return;
          }
          reject(new Error(message.message));
        }, true);
        return;
      }
      const validSuccess =
        message.text.length === message.returnedCharacters &&
        message.returnedCharacters <= limits.maxRetainedCharacters &&
        message.returnedCharacters <= message.totalCharacters &&
        message.totalPages <= limits.maxPages &&
        message.processedPages === message.totalPages;
      if (!validSuccess) {
        settle(
          () =>
            reject(new Error("PDF extraction worker exceeded its contract.")),
          true,
        );
        return;
      }
      settle(
        () =>
          resolve(
            Object.freeze({
              text: message.text,
              textBounds: Object.freeze({
                truncated: message.totalCharacters > message.returnedCharacters,
                totalCharacters: message.totalCharacters,
                returnedCharacters: message.returnedCharacters,
                omittedCharacters:
                  message.totalCharacters - message.returnedCharacters,
                maxCharacters: limits.maxRetainedCharacters,
              }),
              format: Object.freeze({
                kind: "pdf",
                totalPages: message.totalPages,
                processedPages: message.processedPages,
                maxPages: limits.maxPages,
              }),
            }),
          ),
        true,
      );
    });
    worker.once("error", (error: Error & { code?: string }) => {
      settle(
        () =>
          reject(
            error.code === "ERR_WORKER_OUT_OF_MEMORY"
              ? resourceLimitError("PDF extraction exceeded the memory limit.")
              : error,
          ),
        false,
      );
    });
    worker.once("exit", (code) => {
      if (code === 0) {
        settle(
          () =>
            reject(new Error("PDF extraction worker exited without a result.")),
          false,
        );
        return;
      }
      settle(
        () =>
          reject(
            resourceLimitError(
              "PDF extraction stopped after exceeding a resource limit.",
            ),
          ),
        false,
      );
    });
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) onAbort();
  });
}
