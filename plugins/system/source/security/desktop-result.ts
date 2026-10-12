import type {
  NativeComputerBackend,
  NativeComputerResult,
  PhysicalRectangle,
} from "../../../../src/plugin-sdk/computer-access.js";
import { redactSecretText } from "./secret-text.js";

type TextScanner = (input: string) => string;

function rectangle(value: PhysicalRectangle): PhysicalRectangle {
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

/** Explicit native observation fields; binding identities are never rewritten. */
function projectDesktopFields(
  result: NativeComputerResult,
  text: TextScanner,
): NativeComputerResult {
  const capability = (
    value: NativeComputerResult["desktop"]["capabilities"]["capture"],
  ) => ({
    supported: value.supported,
    available: value.available,
    ...(value.reason === undefined ? {} : { reason: text(value.reason) }),
  });
  const desktop = result.desktop;
  return {
    desktop: {
      platform: desktop.platform,
      binding: desktop.binding,
      name: text(desktop.name),
      available: desktop.available,
      ...(desktop.reason === undefined ? {} : { reason: text(desktop.reason) }),
      bounds: rectangle(desktop.bounds),
      ...(desktop.coordinateSpace === undefined
        ? {}
        : { coordinateSpace: desktop.coordinateSpace }),
      capabilities: {
        capture: capability(desktop.capabilities.capture),
        accessibility: capability(desktop.capabilities.accessibility),
        input: capability(desktop.capabilities.input),
        windows: capability(desktop.capabilities.windows),
      },
      targetingGuarantee: desktop.targetingGuarantee,
    },
    windows: result.windows.map((window) => ({
      binding: window.binding,
      title: text(window.title),
      ...(window.application === undefined
        ? {}
        : { application: text(window.application) }),
      bounds: rectangle(window.bounds),
      focused: window.focused,
    })),
    ...(result.focusedWindow === undefined
      ? {}
      : { focusedWindow: result.focusedWindow }),
    ...(result.observation
      ? {
          observation: {
            capturedAt: text(result.observation.capturedAt),
            region: rectangle(result.observation.region),
            imageWidth: result.observation.imageWidth,
            imageHeight: result.observation.imageHeight,
            accessibility: result.observation.accessibility.map((node) => ({
              role: text(node.role),
              ...(node.name === undefined ? {} : { name: text(node.name) }),
              ...(node.value === undefined ? {} : { value: text(node.value) }),
              ...(node.bounds === undefined
                ? {}
                : { bounds: rectangle(node.bounds) }),
              ...(node.focused === undefined ? {} : { focused: node.focused }),
            })),
            accessibilityTruncated: result.observation.accessibilityTruncated,
          },
        }
      : {}),
    ...(result.dispatch
      ? {
          dispatch: {
            status: result.dispatch.status,
            requestedInputCount: result.dispatch.requestedInputCount,
            ...(result.dispatch.acceptedInputCount === undefined
              ? {}
              : { acceptedInputCount: result.dispatch.acceptedInputCount }),
            ...(result.dispatch.reason === undefined
              ? {}
              : { reason: text(result.dispatch.reason) }),
          },
        }
      : {}),
    ...(result.error
      ? {
          error: {
            code: text(result.error.code),
            message: text(result.error.message),
          },
        }
      : {}),
  };
}

/**
 * Best-effort text protection before frame retention or result projection.
 * Pixels are not inspected: a text match withholds the associated entire image.
 */
export function protectDesktopResult(
  result: NativeComputerResult,
  scan: TextScanner = redactSecretText,
): NativeComputerResult {
  let suspected = false;
  try {
    const protectedResult = projectDesktopFields(result, (input) => {
      const output = scan(input);
      if (typeof output !== "string")
        throw new Error("desktop_text_scan_failed");
      suspected ||= output !== input;
      return output;
    });
    if (!suspected)
      return {
        ...protectedResult,
        ...(result.image
          ? {
              image: {
                mimeType: result.image.mimeType,
                bytes: result.image.bytes,
              },
            }
          : {}),
      };
    result.image?.bytes.fill(0);
    return {
      ...protectedResult,
      ...(result.image && !protectedResult.error
        ? {
            error: {
              code: "computer_image_secret_blocked",
              message:
                "Image withheld because desktop text contained a suspected secret. The dispatch receipt is unchanged.",
            },
          }
        : {}),
    };
  } catch {
    result.image?.bytes.fill(0);
    const safe = projectDesktopFields(result, () => "[REDACTED]");
    return {
      desktop: {
        ...safe.desktop,
        reason: "Desktop content withheld because its protection check failed.",
      },
      windows: [],
      ...(safe.focusedWindow === undefined
        ? {}
        : { focusedWindow: safe.focusedWindow }),
      ...(safe.dispatch ? { dispatch: safe.dispatch } : {}),
      error: {
        code: "computer_observation_protection_failed",
        message:
          "Desktop content withheld because its protection check failed. The dispatch receipt is unchanged.",
      },
    };
  }
}

/** Local SYSTEM policy only; Companion results are protected by their producer. */
export function protectNativeDesktopBackend(
  backend: NativeComputerBackend,
): NativeComputerBackend {
  return {
    async execute(request, signal) {
      return protectDesktopResult(await backend.execute(request, signal));
    },
    close: () => backend.close(),
  };
}
