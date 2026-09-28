/** Opaque image evidence issued by an admitted execution, never a file path. */
export type ToolImageEvidence = Readonly<{
  kind: "tool_image_v1";
  id: string;
  mimeType: "image/png";
  size: number;
  width: number;
  height: number;
  sha256: string;
}>;

export type ToolMediaWriter = Readonly<{
  writeImage(input: Readonly<{
    bytes: Uint8Array;
    mimeType: string;
  }>): Promise<ToolImageEvidence>;
}>;

export type ToolRequestDisposer = (callback: () => void | Promise<void>) => void;

export const TOOL_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const TOOL_RESULT_IMAGE_LIMIT = 4;

const IMAGE_FIELDS = new Set([
  "kind", "id", "mimeType", "size", "width", "height", "sha256",
]);

export function isToolImageEvidence(value: unknown): value is ToolImageEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !IMAGE_FIELDS.has(key))) return false;
  if (item.kind !== "tool_image_v1" || item.mimeType !== "image/png") return false;
  if (typeof item.id !== "string" || !/^image-[a-f0-9-]{36}$/u.test(item.id)) return false;
  if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256)) return false;
  if (!isBoundedImageInteger(item.size, TOOL_IMAGE_MAX_BYTES)) return false;
  if (!isBoundedImageInteger(item.width, 32768)) return false;
  if (!isBoundedImageInteger(item.height, 32768)) return false;
  return item.width * item.height <= 64 * 1024 * 1024;
}

function isBoundedImageInteger(value: unknown, maximum: number): value is number {
  if (!Number.isSafeInteger(value)) return false;
  return (value as number) > 0 && (value as number) <= maximum;
}

export function isToolResultMedia(value: unknown): value is readonly ToolImageEvidence[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > TOOL_RESULT_IMAGE_LIMIT) return false;
  if (!value.every(isToolImageEvidence)) return false;
  return new Set(value.map(({ id }) => id)).size === value.length;
}
