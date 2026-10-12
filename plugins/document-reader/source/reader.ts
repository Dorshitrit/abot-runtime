import { readBoundedRegularFile } from "../../../src/plugin-sdk/index.js";

import { MAX_DOCUMENT_BYTES } from "./constants.js";
import { rethrowDocumentIoError } from "./errors.js";
import { failDocumentRead } from "./read-failure.js";
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
    if (!file.ok) failDocumentRead(file, MAX_DOCUMENT_BYTES);
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
