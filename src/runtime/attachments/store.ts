import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type {
  RuntimeAttachmentKind,
  RuntimeAttachmentReference,
} from "../../shared/attachments.js";
import {
  normalizeRuntimeAttachmentMimeType,
  resolveRuntimeAttachmentMimeType,
} from "../../shared/attachments.js";

export type { RuntimeAttachmentKind, RuntimeAttachmentReference };

export type RuntimeAttachmentSaveInput = {
  sessionId: string;
  requestId: string;
  kind: RuntimeAttachmentKind;
  mimeType: string;
  bytes: Uint8Array;
  name?: string;
};

export type RuntimeAttachmentResolution = {
  metadata: RuntimeAttachmentReference;
  absolutePath: string;
};

export type RuntimeAttachmentStore = {
  saveAttachment: (
    input: RuntimeAttachmentSaveInput,
  ) => Promise<RuntimeAttachmentReference>;
  validateAttachmentReferences: (
    attachments: RuntimeAttachmentReference[],
    options?: { sessionId?: string },
  ) => Promise<RuntimeAttachmentReference[]>;
  resolveAttachment: (
    attachment: RuntimeAttachmentReference,
  ) => Promise<RuntimeAttachmentResolution>;
  deleteAttachment?: (
    attachment: RuntimeAttachmentReference,
    options?: { sessionId?: string },
  ) => Promise<void>;
  deleteSessionAttachments: (sessionId: string) => Promise<void>;
};

export type FileAttachmentStoreOptions = {
  attachmentsDir: string;
  maxAttachmentBytes?: number;
};

export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeOwnerSegment(value: string): void {
  if (
    !SAFE_SEGMENT_PATTERN.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new Error("attachment_owner_invalid");
  }
}

export function parseRuntimeAttachmentReferences(
  value: unknown,
): RuntimeAttachmentReference[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("attachments_must_be_array");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("attachment_must_be_object");
    }
    if (
      typeof entry.id !== "string" ||
      typeof entry.mimeType !== "string" ||
      typeof entry.storageRef !== "string"
    ) {
      throw new Error("attachment_reference_invalid");
    }
    if ("data" in entry || "base64" in entry || "content" in entry) {
      throw new Error("attachment_inline_payload_unsupported");
    }
    if (entry.kind !== "image" && entry.kind !== "file") {
      throw new Error("attachment_kind_unsupported");
    }
    const mimeType = normalizeRuntimeAttachmentMimeType(entry.mimeType);
    const supported = resolveRuntimeAttachmentMimeType(mimeType);
    if (!supported || supported.kind !== entry.kind) {
      throw new Error("attachment_mime_unsupported");
    }
    return {
      id: entry.id,
      kind: entry.kind,
      mimeType,
      storageRef: entry.storageRef,
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      ...(typeof entry.size === "number" ? { size: entry.size } : {}),
    };
  });
}

export function createFileAttachmentStore(
  options: FileAttachmentStoreOptions,
): RuntimeAttachmentStore {
  const rootDir = resolve(options.attachmentsDir);
  const maxAttachmentBytes =
    options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  const assertSupported = (attachment: RuntimeAttachmentReference): void => {
    if (!ATTACHMENT_ID_PATTERN.test(attachment.id)) {
      throw new Error("attachment_id_invalid");
    }
    const supported = resolveRuntimeAttachmentMimeType(attachment.mimeType);
    if (!supported || supported.kind !== attachment.kind) {
      throw new Error("attachment_mime_unsupported");
    }
    if (
      attachment.size !== undefined &&
      (!Number.isFinite(attachment.size) ||
        attachment.size < 0 ||
        attachment.size > maxAttachmentBytes)
    ) {
      throw new Error("attachment_size_invalid");
    }
  };

  const resolveStorageRefPath = (
    storageRef: string,
  ): { absolutePath: string; relativePath: string } => {
    if (
      !storageRef ||
      storageRef.startsWith("/") ||
      storageRef.includes("\0")
    ) {
      throw new Error("attachment_storage_ref_invalid");
    }
    const absolutePath = resolve(rootDir, storageRef);
    const relativePath = relative(rootDir, absolutePath);
    if (relativePath.startsWith("..") || relativePath === "") {
      throw new Error("attachment_storage_ref_outside_root");
    }
    return { absolutePath, relativePath };
  };

  const resolveStorageRef = (storageRef: string): string => {
    return resolveStorageRefPath(storageRef).absolutePath;
  };

  const assertStorageRefOwner = (
    attachment: RuntimeAttachmentReference,
    sessionId?: string,
  ): void => {
    if (!sessionId) {
      return;
    }
    assertSafeOwnerSegment(sessionId);
    const { relativePath } = resolveStorageRefPath(attachment.storageRef);
    const [owner] = relativePath.split(/[\\/]/u);
    if (owner !== sessionId) {
      throw new Error("attachment_session_mismatch");
    }
  };

  const normalizeReference = async (
    attachment: RuntimeAttachmentReference,
    options: { sessionId?: string } = {},
  ): Promise<RuntimeAttachmentReference> => {
    assertSupported(attachment);
    const mimeType = normalizeRuntimeAttachmentMimeType(attachment.mimeType);
    assertStorageRefOwner(attachment, options.sessionId);
    const absolutePath = resolveStorageRef(attachment.storageRef);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      throw new Error("attachment_storage_ref_not_file");
    }
    if (fileStat.size > maxAttachmentBytes) {
      throw new Error("attachment_size_exceeded");
    }
    return {
      id: attachment.id,
      kind: attachment.kind,
      mimeType,
      storageRef: attachment.storageRef,
      ...(attachment.name ? { name: attachment.name } : {}),
      size: attachment.size ?? fileStat.size,
    };
  };

  return {
    async saveAttachment(
      input: RuntimeAttachmentSaveInput,
    ): Promise<RuntimeAttachmentReference> {
      const mimeType = normalizeRuntimeAttachmentMimeType(input.mimeType);
      const supported = resolveRuntimeAttachmentMimeType(mimeType);
      if (!supported || supported.kind !== input.kind) {
        throw new Error("attachment_type_unsupported");
      }
      if (input.bytes.byteLength > maxAttachmentBytes) {
        throw new Error("attachment_size_exceeded");
      }
      assertSafeOwnerSegment(input.sessionId);
      assertSafeOwnerSegment(input.requestId);
      const id = `att-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const storageRef = join(
        input.sessionId,
        input.requestId,
        `${id}${supported.extension}`,
      );
      const absolutePath = resolveStorageRef(storageRef);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, input.bytes);
      return {
        id,
        kind: input.kind,
        mimeType,
        storageRef,
        ...(input.name ? { name: input.name } : {}),
        size: input.bytes.byteLength,
      };
    },

    async validateAttachmentReferences(
      attachments: RuntimeAttachmentReference[],
      options: { sessionId?: string } = {},
    ): Promise<RuntimeAttachmentReference[]> {
      return Promise.all(
        attachments.map((attachment) =>
          normalizeReference(attachment, options),
        ),
      );
    },

    async resolveAttachment(
      attachment: RuntimeAttachmentReference,
    ): Promise<RuntimeAttachmentResolution> {
      const metadata = await normalizeReference(attachment);
      return {
        metadata,
        absolutePath: resolveStorageRef(metadata.storageRef),
      };
    },

    async deleteAttachment(
      attachment: RuntimeAttachmentReference,
      options: { sessionId?: string } = {},
    ): Promise<void> {
      assertSupported(attachment);
      assertStorageRefOwner(attachment, options.sessionId);
      await rm(resolveStorageRef(attachment.storageRef), {
        force: true,
      });
    },

    async deleteSessionAttachments(sessionId: string): Promise<void> {
      assertSafeOwnerSegment(sessionId);
      await rm(resolveStorageRef(sessionId), { recursive: true, force: true });
    },
  };
}
