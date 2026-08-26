import type { Readable } from "node:stream";

import JSZip from "jszip";

import {
  MAX_ARCHIVE_DECLARED_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_TOTAL_XML_BYTES,
  MAX_XML_ENTRY_BYTES,
} from "./constants.js";
import { DocumentReaderError, failDocument } from "./errors.js";
import type { ArchiveExtractionMetadata } from "./types.js";

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const MAX_END_RECORD_SEARCH_BYTES = 65_557;

export type ArchiveDirectory = Readonly<{
  declaredEntries: number;
  declaredUncompressedBytes: number;
}>;

export type ArchiveBudget = {
  expandedXmlBytes: number;
  processedXmlEntries: number;
};

export type LoadedOfficeArchive = Readonly<{
  zip: JSZip;
  directory: ArchiveDirectory;
  budget: ArchiveBudget;
}>;

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  if (bytes.byteLength < 22) {
    failDocument("document_archive_invalid", "The OOXML archive is invalid.");
  }
  const minimumOffset = Math.max(
    0,
    bytes.byteLength - MAX_END_RECORD_SEARCH_BYTES,
  );
  for (
    let offset = bytes.byteLength - 22;
    offset >= minimumOffset;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  failDocument("document_archive_invalid", "The OOXML archive is invalid.");
}

export function validateArchiveDirectory(bytes: Uint8Array): ArchiveDirectory {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes, view);
  const entryCount = view.getUint16(endOffset + 10, true);
  const diskEntryCount = view.getUint16(endOffset + 8, true);
  const directoryBytes = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const diskNumber = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  if (
    diskNumber !== 0 ||
    directoryDisk !== 0 ||
    diskEntryCount !== entryCount ||
    entryCount === 0xffff ||
    directoryBytes === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    failDocument(
      "document_archive_unsupported",
      "Multi-disk and ZIP64 OOXML archives are not supported.",
    );
  }
  if (entryCount > MAX_ARCHIVE_ENTRIES) {
    failDocument(
      "document_archive_entry_limit",
      `The OOXML archive exceeds the ${MAX_ARCHIVE_ENTRIES}-entry limit.`,
    );
  }
  const directoryEnd = directoryOffset + directoryBytes;
  if (directoryEnd > endOffset || directoryEnd > bytes.byteLength) {
    failDocument("document_archive_invalid", "The OOXML archive is invalid.");
  }

  let offset = directoryOffset;
  let declaredUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > directoryEnd ||
      view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE
    ) {
      failDocument("document_archive_invalid", "The OOXML archive is invalid.");
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    if (
      offset + entryLength > directoryEnd ||
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff
    ) {
      failDocument("document_archive_invalid", "The OOXML archive is invalid.");
    }
    if ((flags & 0x1) !== 0) {
      failDocument(
        "document_archive_unsupported",
        "Encrypted OOXML archive entries are not supported.",
      );
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      failDocument(
        "document_archive_unsupported",
        "The OOXML archive uses an unsupported compression method.",
      );
    }
    declaredUncompressedBytes += uncompressedBytes;
    if (declaredUncompressedBytes > MAX_ARCHIVE_DECLARED_BYTES) {
      failDocument(
        "document_archive_expansion_limit",
        "The OOXML archive declares more expanded data than the safe parsing limit.",
      );
    }
    offset += entryLength;
  }
  if (offset !== directoryEnd) {
    failDocument("document_archive_invalid", "The OOXML archive is invalid.");
  }
  return Object.freeze({
    declaredEntries: entryCount,
    declaredUncompressedBytes,
  });
}

export async function loadOfficeArchive(
  bytes: Uint8Array,
): Promise<LoadedOfficeArchive> {
  const directory = validateArchiveDirectory(bytes);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: false });
  } catch {
    failDocument("document_archive_invalid", "The OOXML archive is invalid.");
  }
  return Object.freeze({
    zip,
    directory,
    budget: { expandedXmlBytes: 0, processedXmlEntries: 0 },
  });
}

export async function readBoundedXml(
  entry: JSZip.JSZipObject,
  budget: ArchiveBudget,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    failDocument("document_read_cancelled", "Document reading was cancelled.");
  }
  return new Promise<string>((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer") as Readable;
    const chunks: Buffer[] = [];
    let entryBytes = 0;
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      fail(
        new DocumentReaderError(
          "document_read_cancelled",
          "Document reading was cancelled.",
        ),
      );
    };
    const onData = (chunk: Buffer | Uint8Array | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      entryBytes += buffer.byteLength;
      if (
        entryBytes > MAX_XML_ENTRY_BYTES ||
        budget.expandedXmlBytes + entryBytes > MAX_TOTAL_XML_BYTES
      ) {
        fail(
          new DocumentReaderError(
            "document_archive_expansion_limit",
            "The OOXML document exceeds the safe expanded-text parsing limit.",
          ),
        );
        return;
      }
      chunks.push(buffer);
    };
    const onError = (error: Error) => fail(error);
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      budget.expandedXmlBytes += entryBytes;
      budget.processedXmlEntries += 1;
      resolve(Buffer.concat(chunks, entryBytes).toString("utf8"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

export function archiveMetadata(
  archive: LoadedOfficeArchive,
): ArchiveExtractionMetadata {
  return Object.freeze({
    declaredEntries: archive.directory.declaredEntries,
    declaredUncompressedBytes: archive.directory.declaredUncompressedBytes,
    processedXmlEntries: archive.budget.processedXmlEntries,
    expandedXmlBytes: archive.budget.expandedXmlBytes,
    limits: Object.freeze({
      maxEntries: MAX_ARCHIVE_ENTRIES,
      maxDeclaredUncompressedBytes: MAX_ARCHIVE_DECLARED_BYTES,
      maxXmlEntryBytes: MAX_XML_ENTRY_BYTES,
      maxExpandedXmlBytes: MAX_TOTAL_XML_BYTES,
    }),
  });
}
