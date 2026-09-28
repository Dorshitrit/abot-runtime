import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertValidSessionId } from "../record/rules.js";
import { syncSessionDirectory } from "../durable-session-commit.js";
import type {
  SessionBlobReference,
  SessionContinuationReference,
} from "./contracts.js";

function isContentAddressedReference(value: SessionBlobReference): boolean {
  if (!value || !/^[a-f0-9]{64}$/.test(value.sha256)) return false;
  return Number.isSafeInteger(value.byteLength) && value.byteLength >= 0;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertContinuationJson(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object")
    throw new Error("continuation_value_not_serializable");
  if (ancestors.has(value))
    throw new Error("continuation_value_not_serializable");
  const prototype = Object.getPrototypeOf(value);
  const plainObject = prototype === Object.prototype || prototype === null;
  if (!Array.isArray(value) && !plainObject)
    throw new Error("continuation_value_not_serializable");
  if (Object.getOwnPropertySymbols(value).length)
    throw new Error("continuation_value_not_serializable");
  ancestors.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value))
    assertContinuationJson(entry, ancestors);
  ancestors.delete(value);
}

function encodeContinuationJson(value: unknown): Buffer {
  assertContinuationJson(value, new Set());
  return Buffer.from(JSON.stringify(value), "utf8");
}

export function assertContinuationSchema(
  reference: Pick<SessionContinuationReference, "schema" | "version">,
): void {
  if (typeof reference.schema !== "string" || !reference.schema.trim())
    throw new Error("continuation_schema_required");
  if (!Number.isSafeInteger(reference.version) || reference.version < 1)
    throw new Error("continuation_version_invalid");
}

/** Immutable content only. These files never contain approval or lifecycle authority. */
export function createSessionContinuationBlobs(sessionsDir: string) {
  function directory(sessionId: string): string {
    assertValidSessionId(sessionId);
    return join(
      sessionsDir,
      ".request-continuations",
      encodeURIComponent(sessionId),
    );
  }

  async function readBlob(
    sessionId: string,
    reference: SessionBlobReference,
  ): Promise<Uint8Array> {
    if (!isContentAddressedReference(reference))
      throw new Error("continuation_blob_reference_invalid");
    const bytes = await readFile(
      join(directory(sessionId), `${reference.sha256}.blob`),
    );
    if (
      bytes.byteLength !== reference.byteLength ||
      hashBytes(bytes) !== reference.sha256
    )
      throw new Error("continuation_blob_integrity_mismatch");
    return bytes;
  }

  async function writeBlob(
    sessionId: string,
    value: Uint8Array,
  ): Promise<SessionBlobReference> {
    if (!(value instanceof Uint8Array))
      throw new Error("continuation_blob_bytes_required");
    const bytes = Buffer.from(value);
    const reference = {
      sha256: hashBytes(bytes),
      byteLength: bytes.byteLength,
    };
    const parent = directory(sessionId);
    await mkdir(parent, { recursive: true });
    const target = join(parent, `${reference.sha256}.blob`);
    const temporary = join(parent, `${reference.sha256}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await readBlob(sessionId, reference);
      await syncSessionDirectory(parent);
      // A new session's directory entries must survive with its saved reference.
      await syncSessionDirectory(join(sessionsDir, ".request-continuations"));
      await syncSessionDirectory(sessionsDir);
      return reference;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  return {
    writeBlob,
    readBlob,
    async writeContinuation(
      sessionId: string,
      input: Readonly<{ schema: string; version: number; value: unknown }>,
    ): Promise<SessionContinuationReference> {
      assertContinuationSchema(input);
      return {
        schema: input.schema,
        version: input.version,
        blob: await writeBlob(sessionId, encodeContinuationJson(input.value)),
      };
    },
    async readContinuation(
      sessionId: string,
      reference: SessionContinuationReference,
    ): Promise<unknown> {
      assertContinuationSchema(reference);
      return JSON.parse(
        Buffer.from(await readBlob(sessionId, reference.blob)).toString("utf8"),
      );
    },
  };
}
