import { createHash } from "node:crypto";
import {
  isToolImageEvidence,
  TOOL_RESULT_IMAGE_LIMIT,
  type ToolImageEvidence,
} from "../../capabilities/tool-media.js";
import { validateToolImage } from "./tool-image-validation.js";

export const REQUEST_TOOL_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
export type ToolMediaOwner = Readonly<{ callId: string; executionId: string }>;
export type StoredToolImage = Readonly<{
  owner: ToolMediaOwner;
  reference: ToolImageEvidence;
  bytes: Buffer;
}>;
export type RequestToolMediaSnapshot = Readonly<{
  kind: "request_tool_media_v1";
  images: readonly Readonly<{
    owner: ToolMediaOwner;
    reference: ToolImageEvidence;
    data: string;
  }>[];
}>;

/** Private request persistence only; these bytes never become session history. */
export function captureToolMediaSnapshot(
  images: Iterable<StoredToolImage>,
): RequestToolMediaSnapshot {
  return Object.freeze({
    kind: "request_tool_media_v1",
    images: Object.freeze(
      [...images].map((image) =>
        Object.freeze({
          owner: Object.freeze({ ...image.owner }),
          reference: Object.freeze({ ...image.reference }),
          data: image.bytes.toString("base64"),
        }),
      ),
    ),
  });
}

/** Validate every record before installing any image into a live request store. */
export function restoreToolMediaSnapshot(
  value: unknown,
): readonly StoredToolImage[] {
  if (!isSnapshot(value)) throw invalid();
  const ids = new Set<string>();
  const executionOwners = new Map<string, string>();
  const executionCounts = new Map<string, number>();
  let totalBytes = 0;
  // Reject size/count violations before decoding or retaining large buffers.
  for (const image of value.images) {
    if (!isOwner(image?.owner) || !isToolImageEvidence(image?.reference))
      throw invalid();
    if (ids.has(image.reference.id)) throw invalid();
    ids.add(image.reference.id);
    const owner = executionOwners.get(image.owner.executionId);
    if (owner !== undefined && owner !== image.owner.callId) throw invalid();
    executionOwners.set(image.owner.executionId, image.owner.callId);
    const count = (executionCounts.get(image.owner.executionId) ?? 0) + 1;
    if (count > TOOL_RESULT_IMAGE_LIMIT)
      throw new Error("tool_media_execution_limit");
    executionCounts.set(image.owner.executionId, count);
    totalBytes += image.reference.size;
    if (totalBytes > REQUEST_TOOL_MEDIA_MAX_BYTES)
      throw new Error("tool_media_request_limit");
    if (!hasExactEncodedSize(image.data, image.reference.size)) throw invalid();
  }
  const images: StoredToolImage[] = [];
  try {
    for (const image of value.images) images.push(restoreImage(image));
    return Object.freeze(images);
  } catch (error) {
    for (const image of images) image.bytes.fill(0);
    throw error;
  }
}

function restoreImage(
  image: RequestToolMediaSnapshot["images"][number],
): StoredToolImage {
  const bytes = Buffer.from(image.data, "base64");
  try {
    if (
      bytes.toString("base64") !== image.data ||
      bytes.length !== image.reference.size
    )
      throw invalid();
    if (
      createHash("sha256").update(bytes).digest("hex") !==
      image.reference.sha256
    )
      throw invalid();
    const metadata = validateToolImage(bytes, image.reference.mimeType);
    if (
      metadata.width !== image.reference.width ||
      metadata.height !== image.reference.height
    )
      throw invalid();
    return Object.freeze({
      owner: Object.freeze({ ...image.owner }),
      reference: Object.freeze({ ...image.reference }),
      bytes,
    });
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}
function isSnapshot(value: unknown): value is RequestToolMediaSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as RequestToolMediaSnapshot;
  return (
    snapshot.kind === "request_tool_media_v1" && Array.isArray(snapshot.images)
  );
}
function isOwner(value: unknown): value is ToolMediaOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as ToolMediaOwner;
  return (
    typeof owner.callId === "string" &&
    owner.callId.length > 0 &&
    typeof owner.executionId === "string" &&
    owner.executionId.length > 0
  );
}
function hasExactEncodedSize(data: unknown, bytes: number): data is string {
  return typeof data === "string" && data.length === 4 * Math.ceil(bytes / 3);
}
function invalid(): Error {
  return new Error("tool_media_snapshot_invalid");
}
