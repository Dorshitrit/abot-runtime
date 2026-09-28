import type {
  ComputerPlatform,
  NativeComputerDispatch,
  NativeComputerResult,
} from "./native-protocol.js";
import { readNativeComputerResult } from "./native-validation.js";

export const NATIVE_PNG_LIMIT = 10 * 1024 * 1024;
export const NATIVE_JSON_LIMIT =
  Math.ceil(NATIVE_PNG_LIMIT / 3) * 4 + 512 * 1024;

export function unavailableUnixDesktop(
  platform: ComputerPlatform,
  reason: string,
  dispatch?: NativeComputerDispatch,
): NativeComputerResult {
  const unavailable = { supported: true, available: false, reason };
  return {
    desktop: {
      platform,
      binding: `unavailable:${platform}`,
      name: "User desktop",
      available: false,
      reason,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      capabilities: {
        capture: unavailable,
        input: unavailable,
        accessibility: unavailable,
        windows: unavailable,
      },
      targetingGuarantee: "observed_surface",
    },
    windows: [],
    ...(dispatch ? { dispatch } : {}),
    error: {
      code: reason,
      message:
        "The native desktop operation is unavailable. Inspect the reported prerequisite before trying again.",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readUnixDispatch(value: unknown): NativeComputerDispatch {
  if (!isRecord(value)) throw new Error("native_dispatch_invalid");
  if (
    !["not_dispatched", "accepted", "partial", "unknown"].includes(
      String(value.status),
    )
  )
    throw new Error("native_dispatch_invalid");
  if (
    !Number.isSafeInteger(value.requestedInputCount) ||
    Number(value.requestedInputCount) < 0
  )
    throw new Error("native_dispatch_invalid");
  if (
    value.acceptedInputCount !== undefined &&
    (!Number.isSafeInteger(value.acceptedInputCount) ||
      Number(value.acceptedInputCount) < 0)
  )
    throw new Error("native_dispatch_invalid");
  return value as NativeComputerDispatch;
}

/** JSON is mechanical helper data; only validated native image bytes cross this boundary. */
export function readUnixNativeResult(
  value: unknown,
  platform: ComputerPlatform,
): NativeComputerResult {
  if (!isRecord(value)) throw new Error("native_result_invalid");
  const { imageBase64, ...metadata } = value;
  const result = readNativeComputerResult(metadata);
  if (result.desktop.platform !== platform)
    throw new Error("native_desktop_invalid");
  let image: NativeComputerResult["image"];
  if (imageBase64 !== undefined) {
    if (
      typeof imageBase64 !== "string" ||
      imageBase64.length > Math.ceil(NATIVE_PNG_LIMIT / 3) * 4
    )
      throw new Error("native_image_limit");
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(imageBase64))
      throw new Error("native_image_invalid");
    const bytes = Buffer.from(imageBase64, "base64");
    if (
      bytes.length > NATIVE_PNG_LIMIT ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("native_image_invalid");
    if (!result.observation)
      throw new Error("native_image_without_observation");
    image = { mimeType: "image/png", bytes };
  }
  return { ...result, ...(image ? { image } : {}) };
}
