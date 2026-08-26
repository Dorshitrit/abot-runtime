import { sanitizeJsonText } from "../../../src/plugin-sdk/index.js";

export function boundUtf8Text(
  value: string,
  options: Readonly<{ maxBytes: number; marker?: string }>,
): Readonly<{ text: string; truncated: boolean }> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const safe = sanitizeJsonText(value);
  if (Buffer.byteLength(safe, "utf8") <= options.maxBytes) {
    return Object.freeze({ text: safe, truncated: false });
  }
  const decodeValidPrefix = (bytes: Buffer, maxBytes: number): string => {
    let end = Math.min(bytes.byteLength, maxBytes);
    while (end > 0) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, end),
        );
      } catch {
        end -= 1;
      }
    }
    return "";
  };
  const marker = decodeValidPrefix(
    Buffer.from(
      sanitizeJsonText(options.marker ?? "\n[output truncated]"),
      "utf8",
    ),
    options.maxBytes,
  );
  const markerLength = Buffer.byteLength(marker, "utf8");
  const sourceBudget = Math.max(options.maxBytes - markerLength, 0);
  const prefix = decodeValidPrefix(Buffer.from(safe, "utf8"), sourceBudget);
  const text = `${prefix}${marker}`;
  return Object.freeze({
    text,
    truncated: true,
  });
}
