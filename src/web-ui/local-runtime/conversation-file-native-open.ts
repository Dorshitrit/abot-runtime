import { spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { extname, isAbsolute } from "node:path";
import { ConversationFileError } from "./conversation-file-format.js";
import { isLocalNativeFileRequest } from "./conversation-file-native-request.js";
import type { OpenedConversationFile } from "./conversation-file-target.js";

// A document action must never dispatch a script, application, or active web page.
const NATIVE_DOCUMENT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".tsv",
  ".log",
  ".yaml",
  ".yml",
  ".pdf",
  ".rtf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".tif",
  ".tiff",
  ".heic",
  ".avif",
]);

export type ConversationNativeOpenOptions = {
  platform?: NodeJS.Platform;
  launch?: (absolutePath: string) => Promise<void>;
};

function isNativeDocument(file: OpenedConversationFile): boolean {
  if (!file.stats.isFile()) return false;
  if ((file.stats.mode & 0o111n) !== 0n) return false;
  return NATIVE_DOCUMENT_EXTENSIONS.has(
    extname(file.target.absolutePath).toLowerCase(),
  );
}

export function canOpenNativeConversationFile(
  request: IncomingMessage,
  file: OpenedConversationFile,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "darwin") return false;
  if (!isLocalNativeFileRequest(request)) return false;
  return isNativeDocument(file);
}

function nativeOpenFailed(): ConversationFileError {
  return new ConversationFileError(
    "native_open_failed",
    502,
    "The file could not be opened in its app. Try again from the preview.",
  );
}

/** Absolute paths are one argv entry; no shell or caller-selected command is used. */
export function launchMacConversationFile(absolutePath: string): Promise<void> {
  if (!isAbsolute(absolutePath)) return Promise.reject(nativeOpenFailed());
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn("/usr/bin/open", [absolutePath], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    const finish = (failure?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (failure) {
        reject(failure);
        return;
      }
      resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(nativeOpenFailed());
    }, 5000);
    child.once("error", () => finish(nativeOpenFailed()));
    child.once("exit", (code) =>
      finish(code === 0 ? undefined : nativeOpenFailed()),
    );
  });
}

export async function openNativeConversationFile(
  file: OpenedConversationFile,
  assertConversationCurrent: () => Promise<void>,
  launch: (absolutePath: string) => Promise<void> = launchMacConversationFile,
): Promise<void> {
  if (!isNativeDocument(file))
    throw new ConversationFileError(
      "native_open_type_unsupported",
      415,
      "This file type can be viewed here but cannot be opened in an app from the conversation.",
    );
  await assertConversationCurrent();
  file.assertCurrentForNativeOpen();
  // The file descriptor remains held through dispatch. After dispatch, the Mac
  // app resolves the pathname asynchronously, like a user opening it in Finder.
  try {
    await launch(file.target.absolutePath);
  } catch {
    throw nativeOpenFailed();
  }
}
