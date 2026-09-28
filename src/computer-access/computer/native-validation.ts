import type {
  NativeComputerRequest,
  NativeComputerResult,
} from "./native-protocol.js";
import {
  computerFields,
  computerInputError,
  computerNumber,
  computerRecord,
  computerText,
  readNativeComputerAction,
  readPhysicalRectangle,
} from "./action-input.js";

export const COMPUTER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const COMPUTER_FRAME_CHUNK_BYTES = 64 * 1024;
export const COMPUTER_CAPABILITY = "computer_control_v1";

export function readNativeComputerRequest(
  value: unknown,
): NativeComputerRequest {
  const request = computerRecord(value);
  if (request.operation === "inspect") {
    computerFields(request, ["operation"]);
    return { operation: request.operation };
  }
  if (request.operation === "observe") {
    return readNativeObservationRequest(request);
  }
  if (request.operation !== "act")
    return computerInputError("Unknown desktop request.");
  computerFields(request, [
    "operation",
    "desktopBinding",
    "expectedWindow",
    "expectedGeometry",
    "action",
    "deadlineEpochMs",
  ]);
  return {
    operation: request.operation,
    desktopBinding: computerText(request.desktopBinding),
    ...(request.expectedWindow === undefined
      ? {}
      : { expectedWindow: computerText(request.expectedWindow) }),
    expectedGeometry: readPhysicalRectangle(request.expectedGeometry),
    action: readNativeComputerAction(request.action),
    deadlineEpochMs: computerNumber(
      request.deadlineEpochMs,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function readNativeObservationRequest(
  request: Record<string, unknown>,
): Extract<NativeComputerRequest, { operation: "observe" }> {
  if (request.region === undefined) {
    computerFields(request, ["operation"]);
    return {
      operation: "observe",
    };
  }
  computerFields(request, [
    "operation",
    "region",
    "desktopBinding",
    "expectedGeometry",
  ]);
  return {
    operation: "observe",
    region: readPhysicalRectangle(request.region),
    desktopBinding: computerText(request.desktopBinding),
    expectedGeometry: readPhysicalRectangle(request.expectedGeometry),
  };
}

/** Validate the private transport independently of trusted TypeScript declarations. */
export function readNativeComputerResult(value: unknown): NativeComputerResult {
  const result = computerRecord(value);
  computerFields(result, [
    "desktop",
    "windows",
    "focusedWindow",
    "observation",
    "dispatch",
    "error",
  ]);
  if (Buffer.byteLength(JSON.stringify(value)) > 96 * 1024)
    return computerInputError("Desktop metadata exceeds its limit.");
  const desktop = computerRecord(result.desktop);
  if (!["windows", "macos", "linux"].includes(String(desktop.platform)))
    return computerInputError("Invalid desktop platform.");
  computerText(desktop.binding);
  computerText(desktop.name);
  if (desktop.reason !== undefined) computerText(desktop.reason);
  if (
    desktop.coordinateSpace !== undefined &&
    !["physical_pixels", "logical_points"].includes(
      String(desktop.coordinateSpace),
    )
  )
    return computerInputError("Invalid desktop coordinate space.");
  if (typeof desktop.available !== "boolean")
    return computerInputError("Invalid desktop availability.");
  readPhysicalRectangle(desktop.bounds);
  if (
    !["verified_window", "observed_surface"].includes(
      String(desktop.targetingGuarantee),
    )
  )
    return computerInputError("Invalid targeting guarantee.");
  const capabilities = computerRecord(desktop.capabilities);
  for (const kind of ["capture", "accessibility", "input", "windows"]) {
    const capability = computerRecord(capabilities[kind]);
    if (capability.reason !== undefined) computerText(capability.reason);
    if (
      typeof capability.supported !== "boolean" ||
      typeof capability.available !== "boolean"
    )
      return computerInputError("Invalid desktop capability.");
  }
  if (!Array.isArray(result.windows) || result.windows.length > 256)
    return computerInputError("Invalid window list.");
  for (const raw of result.windows) {
    const window = computerRecord(raw);
    computerText(window.binding);
    computerText(window.title);
    if (window.application !== undefined) computerText(window.application);
    readPhysicalRectangle(window.bounds);
    if (typeof window.focused !== "boolean")
      return computerInputError("Invalid window focus.");
  }
  if (result.focusedWindow !== undefined) computerText(result.focusedWindow);
  if (result.observation !== undefined) validateObservation(result.observation);
  if (result.dispatch !== undefined) {
    const dispatch = computerRecord(result.dispatch);
    if (
      !["not_dispatched", "accepted", "partial", "unknown"].includes(
        String(dispatch.status),
      )
    )
      return computerInputError("Invalid input dispatch status.");
    readInputCount(dispatch.requestedInputCount);
    if (dispatch.acceptedInputCount !== undefined)
      readInputCount(dispatch.acceptedInputCount);
    if (dispatch.reason !== undefined) computerText(dispatch.reason);
  }
  if (result.error !== undefined) {
    const error = computerRecord(result.error);
    computerText(error.code, 128);
    computerText(error.message);
  }
  return value as NativeComputerResult;
}

function readInputCount(value: unknown): number {
  const count = computerNumber(value, 0, 100000);
  if (!Number.isInteger(count))
    return computerInputError("Invalid input event count.");
  return count;
}

function validateObservation(value: unknown): void {
  const observation = computerRecord(value);
  computerText(observation.capturedAt, 128);
  readPhysicalRectangle(observation.region);
  computerNumber(observation.imageWidth, 1, 65536);
  computerNumber(observation.imageHeight, 1, 65536);
  if (
    !Array.isArray(observation.accessibility) ||
    observation.accessibility.length > 512
  )
    return computerInputError("Invalid accessibility observation.");
  if (typeof observation.accessibilityTruncated !== "boolean")
    return computerInputError("Invalid accessibility coverage.");
  for (const raw of observation.accessibility) {
    const node = computerRecord(raw);
    computerText(node.role, 128);
    if (node.name !== undefined) computerText(node.name);
    if (node.value !== undefined) computerText(node.value);
    if (node.bounds !== undefined) readPhysicalRectangle(node.bounds);
  }
}
