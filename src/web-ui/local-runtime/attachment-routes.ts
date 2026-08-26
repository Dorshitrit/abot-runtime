import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  resolveRuntimeAttachmentMimeType,
  type RuntimeAttachmentReference,
} from "../../shared/attachments.js";
import type { RuntimeEnvironment } from "./contracts.js";
import { getString, readBody, sendAttachmentBytes, sendJson } from "./http.js";

const MAX_ATTACHMENT_UPLOAD_BYTES = 10 * 1024 * 1024;

export function isAttachmentOwnerInvalid(error: unknown): boolean {
  return error instanceof Error && error.message === "attachment_owner_invalid";
}

export async function deleteSessionAttachmentsIfSupported(
  environment: RuntimeEnvironment,
  sessionId: string,
): Promise<void> {
  try {
    await environment.services.attachments.deleteSessionAttachments(sessionId);
  } catch (error) {
    if (!isAttachmentOwnerInvalid(error)) throw error;
  }
}

export class LocalAttachmentRoutes {
  async read(
    req: IncomingMessage,
    res: ServerResponse,
    environment: RuntimeEnvironment,
  ): Promise<void> {
    const parsed = this.readReference(req);
    if (!parsed) {
      sendJson(res, 400, { ok: false, error: "attachment_reference_invalid" });
      return;
    }
    if (parsed.attachment.kind !== "image") {
      sendJson(res, 415, {
        ok: false,
        error: "attachment_preview_unsupported",
      });
      return;
    }
    try {
      const [validated] =
        await environment.services.attachments.validateAttachmentReferences(
          [parsed.attachment],
          { sessionId: parsed.sessionId },
        );
      if (!validated) throw new Error("attachment_reference_invalid");
      const resolved =
        await environment.services.attachments.resolveAttachment(validated);
      sendAttachmentBytes(
        res,
        await readFile(resolved.absolutePath),
        validated.mimeType,
      );
    } catch {
      sendJson(res, 404, { ok: false, error: "attachment_not_found" });
    }
  }

  async upload(
    req: IncomingMessage,
    res: ServerResponse,
    environment: RuntimeEnvironment,
  ): Promise<void> {
    const url = new URL(req.url || "/", "http://localhost");
    const sessionId = getString(url.searchParams.get("sessionId")).trim();
    const fileName = getString(url.searchParams.get("name")).trim();
    const mimeType = getString(req.headers["content-type"]).trim();
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: "sessionId_required" });
      return;
    }
    const supported = resolveRuntimeAttachmentMimeType(mimeType);
    if (!supported) {
      sendJson(res, 400, { ok: false, error: "attachment_type_unsupported" });
      return;
    }
    const contentLength = Number(req.headers["content-length"]);
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_ATTACHMENT_UPLOAD_BYTES
    ) {
      sendJson(res, 413, { ok: false, error: "attachment_size_exceeded" });
      req.resume();
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, { maxBytes: MAX_ATTACHMENT_UPLOAD_BYTES });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "request_body_too_large"
      ) {
        sendJson(res, 413, { ok: false, error: "attachment_size_exceeded" });
        return;
      }
      throw error;
    }
    const random = Math.random().toString(36).slice(2, 8);
    const attachment = await environment.services.attachments.saveAttachment({
      sessionId,
      requestId: `upload-${Date.now()}-${random}`,
      kind: supported.kind,
      mimeType,
      bytes: body,
      ...(fileName ? { name: fileName } : {}),
    });
    sendJson(res, 200, { ok: true, attachment });
  }

  async delete(
    req: IncomingMessage,
    res: ServerResponse,
    environment: RuntimeEnvironment,
  ): Promise<void> {
    const parsed = this.readReference(req);
    if (!parsed) {
      sendJson(res, 400, { ok: false, error: "attachment_reference_invalid" });
      return;
    }
    try {
      await environment.services.attachments.deleteAttachment?.(
        parsed.attachment,
        { sessionId: parsed.sessionId },
      );
      sendJson(res, 200, { ok: true });
    } catch (error) {
      if (isAttachmentOwnerInvalid(error)) {
        sendJson(res, 200, { ok: true });
        return;
      }
      throw error;
    }
  }

  private readReference(
    req: IncomingMessage,
  ): { attachment: RuntimeAttachmentReference; sessionId: string } | undefined {
    const url = new URL(req.url || "/", "http://localhost");
    const storageRef = getString(url.searchParams.get("storageRef")).trim();
    const id = getString(url.searchParams.get("id")).trim();
    const mimeType = getString(url.searchParams.get("mimeType"))
      .trim()
      .toLowerCase();
    const sessionId =
      getString(url.searchParams.get("sessionId")).trim() ||
      storageRef.split(/[\\/]/u)[0]?.trim() ||
      "";
    const supported = resolveRuntimeAttachmentMimeType(mimeType);
    if (!sessionId || !storageRef || !id || !supported) return undefined;
    return {
      sessionId,
      attachment: { id, kind: supported.kind, mimeType, storageRef },
    };
  }
}
