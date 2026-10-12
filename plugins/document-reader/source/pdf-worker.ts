import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { MAX_PDF_ERROR_MESSAGE_CHARS } from "./constants.js";
import { DocumentReaderError } from "./errors.js";
import {
  PDF_EXTRACTION_LIMITS,
  type PdfExtractionLimits,
} from "./pdf-contract.js";
import { runPdfParser } from "./pdf-parser.js";
import { documentFromPdfMessage } from "./pdf-result.js";
import type { ExtractedDocument } from "./types.js";

export {
  PDF_EXTRACTION_LIMITS,
  type PdfExtractionLimits,
} from "./pdf-contract.js";

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
  return new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
    void (${runPdfParser.toString()})(workerData, message => parentPort.postMessage(message))
      .finally(() => parentPort.close());`,
    {
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
    },
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
      settle(() => {
        try {
          resolve(documentFromPdfMessage(message, limits));
        } catch (error) {
          reject(error);
        }
      }, true);
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
