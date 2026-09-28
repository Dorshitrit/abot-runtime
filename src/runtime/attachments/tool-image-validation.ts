import { inflateSync } from "node:zlib";
import { TOOL_IMAGE_MAX_BYTES } from "../../capabilities/tool-media.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Validate bounded, non-interlaced 8-bit PNG pixels before exposing evidence. */
export function validateToolImage(bytes: Uint8Array, mimeType: string) {
  if (mimeType !== "image/png") throw new Error("tool_image_mime_unsupported");
  if (bytes.byteLength === 0 || bytes.byteLength > TOOL_IMAGE_MAX_BYTES)
    throw new Error("tool_image_size_invalid");
  const image = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!image.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("tool_image_png_invalid");
  let width = 0;
  let height = 0;
  let channels = 0;
  let offset = 8;
  let ended = false;
  const pixels: Buffer[] = [];
  while (offset + 12 <= image.length) {
    const size = image.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > image.length) throw new Error("tool_image_png_invalid");
    const type = image.toString("ascii", offset + 4, offset + 8);
    const data = image.subarray(offset + 8, offset + 8 + size);
    if (pngCrc(image.subarray(offset + 4, offset + 8 + size)) !== image.readUInt32BE(end - 4))
      throw new Error("tool_image_png_invalid");
    if (offset === 8 && type !== "IHDR") throw new Error("tool_image_png_invalid");
    if (type === "IHDR") {
      if (offset !== 8 || size !== 13) throw new Error("tool_image_png_invalid");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = CHANNELS[data[9]!] ?? 0;
      if (!width || !height || width > 32768 || height > 32768 || width * height > 64 * 1024 * 1024)
        throw new Error("tool_image_dimensions_invalid");
      if (data[8] !== 8 || !channels || data[10] !== 0 || data[11] !== 0 || data[12] !== 0)
        throw new Error("tool_image_png_format_unsupported");
    }
    if (type === "IDAT") pixels.push(data);
    offset = end;
    if (type !== "IEND") continue;
    if (size !== 0 || offset !== image.length) throw new Error("tool_image_png_invalid");
    ended = true;
    break;
  }
  if (!ended || pixels.length === 0) throw new Error("tool_image_png_invalid");
  const stride = width * channels + 1;
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(pixels), { maxOutputLength: stride * height });
  } catch {
    throw new Error("tool_image_png_invalid");
  }
  try {
    if (decoded.length !== stride * height) throw new Error("tool_image_png_invalid");
    for (let row = 0; row < height; row++) {
      if (decoded[row * stride]! > 4) throw new Error("tool_image_png_invalid");
    }
  } finally {
    decoded.fill(0);
  }
  return Object.freeze({ width, height, mimeType: "image/png" as const });
}

function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
