import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeEnvironmentRegistry } from "./environment-registry.js";
import type { LocalRequestExecution } from "./request-execution.js";
import {
  ConversationFileAccess,
  readConversationFileReference,
} from "./conversation-file-access.js";
import {
  readConversationFile,
  type ConversationFileMode,
} from "./conversation-file-content.js";
import {
  ConversationFileError,
  conversationDownloadDisposition,
} from "./conversation-file-format.js";
import { assertNativeFileOpenRequest } from "./conversation-file-native-request.js";
import {
  canOpenNativeConversationFile,
  openNativeConversationFile,
  type ConversationNativeOpenOptions,
} from "./conversation-file-native-open.js";
import { withConversationFileTarget } from "./conversation-file-target.js";
import { readBody, readJsonBody, sendJson } from "./http.js";

function hasSameOrigin(request: IncomingMessage): boolean {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const secure = "encrypted" in request.socket && request.socket.encrypted;
    const expected = (secure ? "https://" : "http://") + request.headers.host;
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}

function assertFileRequestOrigin(request: IncomingMessage): void {
  if (hasSameOrigin(request)) return;
  throw new ConversationFileError(
    "file_request_rejected",
    403,
    "Files can only be opened from this Web UI.",
  );
}

function contentMode(url: URL): ConversationFileMode {
  if (url.searchParams.get("download") === "1") return "download";
  if (url.searchParams.get("content") === "1") return "image";
  return "preview";
}

async function assertEmptyNativeOpenBody(
  request: IncomingMessage,
): Promise<void> {
  try {
    const body = readJsonBody(await readBody(request, { maxBytes: 1024 }));
    if (Object.keys(body).length === 0) return;
  } catch {
    // The only file authority is the conversation reference in the URL.
  }
  throw new ConversationFileError(
    "file_reference_invalid",
    400,
    "Open this file from the conversation preview.",
  );
}

/** A recorded tool completion is the only authority; no browser path is accepted. */
export class ConversationFileRoutes {
  private readonly access: ConversationFileAccess;

  constructor(
    environments: Pick<
      RuntimeEnvironmentRegistry,
      "environmentConfig" | "setupRequirement" | "get"
    >,
    requests: LocalRequestExecution,
    defaultEnvironmentId: () => string,
    private readonly nativeOpen: ConversationNativeOpenOptions = {},
  ) {
    this.access = new ConversationFileAccess(
      environments,
      requests,
      defaultEnvironmentId,
    );
  }

  async handle(
    route: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const isPreviewRead = route === "chat/files" && request.method === "GET";
    const isNativeOpen =
      route === "chat/files/open" && request.method === "POST";
    if (!isPreviewRead && !isNativeOpen) return false;
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; sandbox",
    );
    try {
      assertFileRequestOrigin(request);
      const platform = this.nativeOpen.platform ?? process.platform;
      if (isNativeOpen) {
        assertNativeFileOpenRequest(request, platform);
        await assertEmptyNativeOpenBody(request);
      }
      const url = new URL(request.url || "/", "http://localhost");
      const reference = readConversationFileReference(url);
      const authority = await this.access.authorize(reference);
      if (isNativeOpen) {
        await withConversationFileTarget(
          authority.receipt,
          authority.paths,
          (file) =>
            openNativeConversationFile(
              file,
              authority.assertCurrent,
              this.nativeOpen.launch,
            ),
        );
        sendJson(response, 200, { ok: true });
        return true;
      }
      const mode = contentMode(url);
      const result = await readConversationFile(
        authority.receipt,
        authority.paths,
        mode,
        (file) => canOpenNativeConversationFile(request, file, platform),
      );
      await authority.assertCurrent();
      if (mode === "preview") {
        sendJson(response, 200, { ok: true, file: result.file });
        return true;
      }
      const bytes = result.bytes!;
      response.setHeader("content-length", String(bytes.byteLength));
      response.setHeader(
        "content-type",
        mode === "image" ? result.file.mimeType : "application/octet-stream",
      );
      if (mode === "download")
        response.setHeader(
          "content-disposition",
          conversationDownloadDisposition(result.file.name),
        );
      response.writeHead(200);
      response.end(bytes);
    } catch (error) {
      const failure =
        error instanceof ConversationFileError
          ? error
          : new ConversationFileError(
              "conversation_file_unavailable",
              404,
              "This file is no longer available in this conversation.",
            );
      sendJson(response, failure.statusCode, {
        ok: false,
        error: failure.code,
        message: failure.message,
      });
    }
    return true;
  }
}
