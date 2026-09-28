import type { NativeComputerRequest, NativeComputerResult } from "./native-protocol.js";
import { readNativeComputerResult } from "./native-validation.js";
import { WINDOWS_IMAGE_MAX_BYTES, type WindowsHelperProcessResult } from "./windows-helper-process.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function windowsHelperUnavailable(
  request: NativeComputerRequest,
  reason: string,
  spawned: boolean,
): NativeComputerResult {
  const capability = { supported: true, available: false, reason };
  return {
    desktop: {
      platform: "windows", binding: "windows:unavailable", name: "Windows desktop",
      available: false, reason, bounds: { x: 0, y: 0, width: 1, height: 1 },
      capabilities: { capture: capability, accessibility: capability, input: capability, windows: capability },
      targetingGuarantee: "observed_surface",
    },
    windows: [],
    ...(request.operation === "act" ? {
      dispatch: {
        status: spawned ? "unknown" as const : "not_dispatched" as const,
        requestedInputCount: 0,
        ...(spawned ? {} : { acceptedInputCount: 0 }),
        reason: spawned ? "native_receipt_unavailable" : reason,
      },
    } : {}),
    error: {
      code: reason,
      message: spawned && request.operation === "act"
        ? "The Windows action receipt is unavailable. Input may have occurred; observe the desktop before another action. No action was replayed."
        : "The Windows desktop helper is unavailable for this operation.",
    },
  };
}

export function decodeWindowsComputerResult(
  process: WindowsHelperProcessResult,
  request: NativeComputerRequest,
): NativeComputerResult {
  if (process.status !== "completed")
    return windowsHelperUnavailable(request, `computer_helper_${process.status}`, process.spawned);
  let result: NativeComputerResult;
  let image: unknown;
  try {
    const wire: unknown = JSON.parse(process.stdout.trim());
    if (wire === null || typeof wire !== "object" || Array.isArray(wire)) throw new Error("invalid result");
    const { image: nativeImage, ...metadata } = wire as Record<string, unknown>;
    result = readNativeComputerResult(metadata);
    image = nativeImage;
    if (result.desktop.platform !== "windows") throw new Error("wrong platform");
    if (request.operation === "act" && !result.dispatch) throw new Error("missing dispatch");
  } catch {
    return windowsHelperUnavailable(request, "computer_helper_protocol_invalid", process.spawned);
  }
  try {
    if (image === undefined) {
      if (request.operation !== "inspect" && !result.error) throw new Error("missing observation");
      return result;
    }
    const bytes = decodeWindowsImage(image, result);
    return { ...result, image: { mimeType: "image/png", bytes } };
  } catch {
    if (result.dispatch) return {
      ...result,
      error: {
        code: "computer_image_decode_failed",
        message: "The native input receipt is preserved, but the captured image is invalid or unavailable. Observe again before another action.",
      },
    };
    return windowsHelperUnavailable(request, "computer_helper_protocol_invalid", process.spawned);
  }
}

function decodeWindowsImage(value: unknown, result: NativeComputerResult): Uint8Array {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid image");
  const image = value as Record<string, unknown>;
  if (Object.keys(image).some((key) => key !== "mimeType" && key !== "base64")) throw new Error("invalid image fields");
  if (image.mimeType !== "image/png" || typeof image.base64 !== "string") throw new Error("invalid image encoding");
  if (image.base64.length > Math.ceil(WINDOWS_IMAGE_MAX_BYTES / 3) * 4) throw new Error("image too large");
  const bytes = Buffer.from(image.base64, "base64");
  try {
    validateWindowsImageBytes(bytes, image.base64, result);
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

function validateWindowsImageBytes(bytes: Buffer, encoded: string, result: NativeComputerResult): void {
  if (bytes.length > WINDOWS_IMAGE_MAX_BYTES || bytes.length < 33) throw new Error("image size");
  if (bytes.toString("base64") !== encoded) throw new Error("noncanonical image encoding");
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("image signature");
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("image header");
  const observation = result.observation;
  if (!observation) throw new Error("missing observation metadata");
  if (bytes.readUInt32BE(16) !== observation.imageWidth || bytes.readUInt32BE(20) !== observation.imageHeight)
    throw new Error("image dimensions disagree");
}
