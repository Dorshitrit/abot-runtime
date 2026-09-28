import {
  captureToolMediaSnapshot,
  restoreToolMediaSnapshot,
} from "./request-tool-media-snapshot.js";
import { createHash, randomUUID } from "node:crypto";
import {
  isToolResultMedia,
  TOOL_RESULT_IMAGE_LIMIT,
  type ToolImageEvidence,
  type ToolMediaWriter,
} from "../../capabilities/tool-media.js";
import { validateToolImage } from "./tool-image-validation.js";

export type ToolMediaOwner = Readonly<{ callId: string; executionId: string }>;
type StoredImage = Readonly<{
  owner: ToolMediaOwner;
  reference: ToolImageEvidence;
  bytes: Buffer;
}>;
const REQUEST_TOOL_MEDIA_MAX_BYTES = 64 * 1024 * 1024;

/** Request-owned binary storage. No paths, history writes, or process registry. */
export class RequestToolMediaStore {
  private readonly images = new Map<string, StoredImage>();
  private bytes = 0;
  private disposed = false;

  beginExecution(owner: ToolMediaOwner, signal: AbortSignal) {
    this.assertOpen();
    const issued = new Set<string>();
    let closed = false;
    const writer: ToolMediaWriter = Object.freeze({
      writeImage: async (input) => {
        this.assertOpen();
        signal.throwIfAborted();
        if (closed) throw new Error("tool_media_execution_closed");
        if (issued.size >= TOOL_RESULT_IMAGE_LIMIT)
          throw new Error("tool_media_execution_limit");
        if (this.bytes + input.bytes.byteLength > REQUEST_TOOL_MEDIA_MAX_BYTES)
          throw new Error("tool_media_request_limit");
        const metadata = validateToolImage(input.bytes, input.mimeType);
        const bytes = Buffer.from(input.bytes);
        const reference: ToolImageEvidence = Object.freeze({
          kind: "tool_image_v1",
          id: `image-${randomUUID()}`,
          ...metadata,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        this.images.set(reference.id, {
          owner: Object.freeze({ ...owner }),
          reference,
          bytes,
        });
        this.bytes += bytes.length;
        issued.add(reference.id);
        return reference;
      },
    });
    return Object.freeze({
      writer,
      finish: (references?: readonly ToolImageEvidence[]) => {
        closed = true;
        if (!isToolResultMedia(references))
          throw new Error("tool_media_reference_invalid");
        for (const reference of references ?? []) {
          if (!issued.has(reference.id))
            throw new Error("tool_media_execution_mismatch");
          this.read(owner, reference);
        }
        const retained = new Set((references ?? []).map(({ id }) => id));
        for (const id of issued) if (!retained.has(id)) this.remove(id);
      },
      close: () => {
        closed = true;
      },
    });
  }

  resolve(owner: ToolMediaOwner, reference: ToolImageEvidence): string {
    return this.read(owner, reference).bytes.toString("base64");
  }

  private read(
    owner: ToolMediaOwner,
    reference: ToolImageEvidence,
  ): StoredImage {
    this.assertOpen();
    const stored = this.images.get(reference.id);
    if (!stored) throw new Error("tool_media_reference_unavailable");
    if (
      stored.owner.callId !== owner.callId ||
      stored.owner.executionId !== owner.executionId
    )
      throw new Error("tool_media_execution_mismatch");
    if (
      !isToolResultMedia([reference]) ||
      Object.entries(stored.reference).some(
        ([key, value]) => reference[key as keyof ToolImageEvidence] !== value,
      )
    )
      throw new Error("tool_media_reference_invalid");
    return stored;
  }

  ownerOf(executionId: string, reference: ToolImageEvidence): ToolMediaOwner {
    this.assertOpen();
    const stored = this.images.get(reference.id);
    if (!stored || stored.owner.executionId !== executionId)
      throw new Error("tool_media_execution_mismatch");
    return stored.owner;
  }

  snapshot() {
    this.assertOpen();
    return captureToolMediaSnapshot(this.images.values());
  }

  restore(snapshot: unknown): void {
    this.assertOpen();
    if (this.images.size) throw new Error("tool_media_restore_not_empty");
    const images = restoreToolMediaSnapshot(snapshot);
    for (const image of images) {
      this.images.set(image.reference.id, image);
      this.bytes += image.bytes.length;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.images.keys()) this.remove(id);
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("tool_media_request_closed");
  }

  private remove(id: string): void {
    const image = this.images.get(id);
    if (!image) return;
    image.bytes.fill(0);
    this.bytes -= image.bytes.length;
    this.images.delete(id);
  }
}
