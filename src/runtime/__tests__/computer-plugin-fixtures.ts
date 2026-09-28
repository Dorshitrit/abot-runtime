import { vi } from "vitest";
import type {
  NativeComputerResult,
  NativeComputerBackend,
} from "../../computer-access/computer/native-protocol.js";
import type { SystemRequestRoute } from "../../../plugins/system/source/request-target-snapshot.js";

export const computerRoute: Extract<SystemRequestRoute, { kind: "native" }> = {
  kind: "native",
  target: { id: "linux", shell: "/bin/bash", transport: "native" },
};
export function desktopFixture(): NativeComputerResult {
  const capability = { supported: true, available: true };
  return {
    desktop: {
      platform: "linux",
      binding: "session:10",
      name: "Test desktop",
      available: true,
      bounds: { x: -1920, y: 0, width: 3840, height: 2160 },
      capabilities: {
        capture: capability,
        input: capability,
        accessibility: capability,
        windows: capability,
      },
      targetingGuarantee: "verified_window",
    },
    windows: [
      {
        binding: "pid:1/start:2/window:3",
        title: "User document",
        bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
        focused: true,
      },
    ],
    focusedWindow: "pid:1/start:2/window:3",
    observation: {
      capturedAt: new Date().toISOString(),
      region: { x: -1920, y: 0, width: 3840, height: 2160 },
      imageWidth: 1920,
      imageHeight: 1080,
      accessibility: [{ role: "document", name: "Observed content" }],
      accessibilityTruncated: false,
    },
    image: { mimeType: "image/png", bytes: Uint8Array.from([1, 2, 3]) },
  };
}
export function backendFixture(): NativeComputerBackend {
  return {
    execute: vi.fn(async () => desktopFixture()),
    close: vi.fn(async () => undefined),
  };
}
