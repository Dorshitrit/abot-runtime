import { readBoundedRegularFile } from "../../../src/plugin-sdk/index.js";

import { MAX_DOCUMENT_BYTES } from "./constants.js";
import { failDocument, rethrowDocumentIoError } from "./errors.js";
import { extractDocumentText } from "./extract.js";
import type { DocumentReference, ExtractedDocument } from "./types.js";

export type ReadDocumentResult = Readonly<{
  bytes: number;
  extracted: ExtractedDocument;
}>;

export async function readDocument(
  document: DocumentReference,
  pdfParseEntrypoint: string,
  signal?: AbortSignal,
): Promise<ReadDocumentResult> {
  try {
    const file = await readBoundedRegularFile(document.absolutePath, {
      maxBytes: MAX_DOCUMENT_BYTES,
      rootPath: document.rootPath,
      ...(signal ? { signal } : {}),
    });
    if (!file.ok && file.reason === "not_regular_file") {
      failDocument(
        "document_target_not_file",
        "The requested document is not a regular file.",
      );
    }
    if (!file.ok && file.reason === "too_large") {
      failDocument(
        "document_file_too_large",
        `The requested document exceeds the ${MAX_DOCUMENT_BYTES}-byte parsing limit.`,
      );
    }
    if (!file.ok) {
      failDocument(
        "document_changed_during_read",
        "The requested document changed while it was being read.",
      );
    }
    const bytes = new Uint8Array(file.bytes);
    return Object.freeze({
      bytes: bytes.byteLength,
      extracted: await extractDocumentText(
        document,
        bytes,
        pdfParseEntrypoint,
        signal,
      ),
    });
  } catch (error) {
    rethrowDocumentIoError(error);
  }
}
