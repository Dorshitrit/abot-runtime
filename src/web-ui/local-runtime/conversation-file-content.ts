import type { FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import type { ToolFileOutputReceipt } from "../../capabilities/file-output-presentation.js";
import type { RuntimePaths } from "../../runtime/ports.js";
import {
  withConversationFileTarget,
  type OpenedConversationFile,
} from "./conversation-file-target.js";
import {
  ConversationFileError,
  MAX_CONVERSATION_DOWNLOAD_BYTES,
  MAX_CONVERSATION_IMAGE_BYTES,
  MAX_CONVERSATION_TEXT_BYTES,
  conversationFileMimeType,
  conversationTextPreview,
  rasterImageMimeType,
} from "./conversation-file-format.js";

export type ConversationFileMode = "preview" | "image" | "download";
export type ConversationFileContent = {
  file: {
    name: string;
    mimeType: string;
    size: number;
    kind: "text" | "image" | "unsupported";
    operation: ToolFileOutputReceipt["operation"];
    content?: string;
    truncated: boolean;
    location: string;
    downloadAvailable: boolean;
    nativeOpenAvailable: boolean;
  };
  bytes?: Buffer;
};

async function readFilePrefix(
  handle: FileHandle,
  size: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead <= 0)
      throw new ConversationFileError(
        "conversation_file_changed",
        409,
        "The file changed while it was being read. Open it again to see the current content.",
      );
    offset += result.bytesRead;
  }
  return bytes;
}

function requestedReadLimit(mode: ConversationFileMode): number {
  if (mode === "download") return MAX_CONVERSATION_DOWNLOAD_BYTES;
  if (mode === "image") return MAX_CONVERSATION_IMAGE_BYTES;
  return MAX_CONVERSATION_TEXT_BYTES;
}

function assertBoundedContent(mode: ConversationFileMode, size: number): void {
  if (mode === "preview") return;
  if (size <= requestedReadLimit(mode)) return;
  throw new ConversationFileError(
    "conversation_file_too_large",
    413,
    mode === "image"
      ? "This image is too large for an inline preview."
      : "This file is too large to download through the Web UI. It remains on your computer.",
  );
}

function previewKind(
  rasterMime: string | undefined,
  size: number,
  text: string | undefined,
): ConversationFileContent["file"]["kind"] {
  if (rasterMime && size <= MAX_CONVERSATION_IMAGE_BYTES) return "image";
  if (text !== undefined) return "text";
  return "unsupported";
}

function projectFileContent(
  receipt: ToolFileOutputReceipt,
  size: number,
  bytes: Buffer,
  mode: ConversationFileMode,
  nativeOpenAvailable: boolean,
): ConversationFileContent {
  const name = basename(receipt.relativePath);
  const rasterMime = rasterImageMimeType(bytes);
  const truncated = bytes.length < size;
  const text =
    mode === "preview" && !rasterMime
      ? conversationTextPreview(name, bytes, truncated)
      : undefined;
  const kind = previewKind(rasterMime, size, text);
  if (mode === "image" && kind !== "image")
    throw new ConversationFileError(
      "conversation_file_preview_unsupported",
      415,
      "This file type cannot be displayed as an image.",
    );
  const mimeType =
    rasterMime ??
    (text !== undefined ? "text/plain" : conversationFileMimeType(name));
  return {
    file: {
      name,
      mimeType,
      size,
      kind,
      operation: receipt.operation,
      ...(mode === "preview" && text !== undefined ? { content: text } : {}),
      truncated: kind === "text" && truncated,
      location: receipt.logicalPath,
      downloadAvailable: size <= MAX_CONVERSATION_DOWNLOAD_BYTES,
      nativeOpenAvailable,
    },
    ...(mode === "preview" ? {} : { bytes }),
  };
}

/** Reads current contents from the tool-owned root without following a replaced leaf. */
export async function readConversationFile(
  receipt: ToolFileOutputReceipt,
  paths: RuntimePaths,
  mode: ConversationFileMode,
  canOpenNative: (file: OpenedConversationFile) => boolean = () => false,
): Promise<ConversationFileContent> {
  return withConversationFileTarget(receipt, paths, async (file) => {
    const size = Number(file.stats.size);
    assertBoundedContent(mode, size);
    const bytes = await readFilePrefix(
      file.handle,
      Math.min(size, requestedReadLimit(mode)),
    );
    await file.assertCurrent();
    return projectFileContent(receipt, size, bytes, mode, canOpenNative(file));
  });
}
