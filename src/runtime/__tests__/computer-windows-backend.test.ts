import { describe, expect, test, vi } from "vitest";
import { createWindowsComputerBackend } from "../../computer-access/computer/windows-backend.js";
import { decodeWindowsComputerResult } from "../../computer-access/computer/windows-result.js";
import type { NativeComputerRequest, NativeComputerResult } from "../../computer-access/computer/native-protocol.js";
import type { runWindowsComputerHelper } from "../../computer-access/computer/windows-helper-process.js";

const target = { id: "windows", transport: "wsl_interop", shell: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" } as const;
const capability = { supported: true, available: true };
const desktop: NativeComputerResult["desktop"] = {
  platform: "windows", binding: "host:session:login", name: "Desktop", available: true,
  bounds: { x: -1920, y: 0, width: 3840, height: 1080 },
  capabilities: { capture: capability, input: capability, accessibility: capability, windows: capability },
  targetingGuarantee: "verified_window",
};
const act = (): NativeComputerRequest => ({
  operation: "act", desktopBinding: desktop.binding, expectedWindow: "window:process:created",
  expectedGeometry: desktop.bounds, action: { kind: "type_text", text: "שלום" },
  deadlineEpochMs: Date.now() + 20_000,
});
const completed = (value: unknown) => ({ status: "completed" as const, spawned: true, exitCode: 0, stdout: JSON.stringify(value) });
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9F8AAAAASUVORK5CYII=", "base64");
function observationResult() {
  return {
    desktop, windows: [], focusedWindow: "window:process:created",
    observation: {
      capturedAt: "2026-09-24T10:00:00.000Z", region: { x: -1920, y: 0, width: 3840, height: 1080 },
      imageWidth: 1, imageHeight: 1, accessibility: [], accessibilityTruncated: true,
    },
    image: { mimeType: "image/png", base64: image.toString("base64") },
  };
}

describe("Windows native result boundary", () => {
  test("lifts bounded image bytes separately from physical observation metadata", () => {
    const result = decodeWindowsComputerResult(completed(observationResult()), { operation: "observe" });
    expect(result.image?.bytes).toEqual(image);
    expect(result.observation?.region.x).toBe(-1920);
    expect(result.image).not.toHaveProperty("base64");
  });

  test("retains accepted input when its subsequent capture failed", () => {
    const receipt = { status: "accepted", requestedInputCount: 8, acceptedInputCount: 8 };
    const result = decodeWindowsComputerResult(completed({
      desktop, windows: [], dispatch: receipt,
      error: { code: "computer_capture_failed", message: "Capture failed after input." },
    }), act());
    expect(result.dispatch).toEqual(receipt);
    expect(result.error?.code).toBe("computer_capture_failed");
    expect(result.image).toBeUndefined();
  });

  test.each(["timeout", "aborted", "output_limit"] as const)("%s after spawn preserves uncertainty", (status) => {
    const result = decodeWindowsComputerResult({ status, stdout: "", spawned: true }, act());
    expect(result.dispatch?.status).toBe("unknown");
    expect(result.dispatch?.acceptedInputCount).toBeUndefined();
    expect(result.error?.message).toContain("No action was replayed");
  });

  test("rejects image dimension mismatch instead of associating different evidence", () => {
    const result = observationResult(); result.observation.imageWidth = 2;
    const decoded = decodeWindowsComputerResult(completed(result), { operation: "observe" });
    expect(decoded.error?.code).toBe("computer_helper_protocol_invalid");
    expect(decoded.image).toBeUndefined();
  });

  test.each([
    { status: "accepted", requestedInputCount: 4, acceptedInputCount: 4 },
    { status: "partial", requestedInputCount: 4, acceptedInputCount: 2 },
  ] as const)("corrupt screenshot preserves a validated $status input receipt", (dispatch) => {
    const result = observationResult();
    const corrupted = Buffer.from(image); corrupted[0] = 0;
    result.image.base64 = corrupted.toString("base64");
    const decoded = decodeWindowsComputerResult(completed({ ...result, dispatch }), act());
    expect(decoded.dispatch).toEqual(dispatch);
    expect(decoded.desktop).toEqual(desktop);
    expect(decoded.error?.code).toBe("computer_image_decode_failed");
    expect(decoded.image).toBeUndefined();
  });

  test("rejects successful observation without pixels, or mutation without a receipt", () => {
    expect(decodeWindowsComputerResult(completed({ desktop, windows: [] }), { operation: "observe" }).error?.code)
      .toBe("computer_helper_protocol_invalid");
    expect(decodeWindowsComputerResult(completed(observationResult()), act()).dispatch?.status).toBe("unknown");
  });

  test("preserves explicit focus drift rejection without inventing input", () => {
    const result = decodeWindowsComputerResult(completed({
      desktop, windows: [], dispatch: { status: "not_dispatched", requestedInputCount: 0, acceptedInputCount: 0 },
      error: { code: "computer_focus_changed", message: "The foreground window changed." },
    }), act());
    expect(result.dispatch?.status).toBe("not_dispatched");
    expect(result.error?.code).toBe("computer_focus_changed");
  });

  test("an unconfirmed focus effect remains unknown even with zero confirmed inputs", () => {
    const result = decodeWindowsComputerResult(completed({
      desktop, windows: [], dispatch: { status: "unknown", requestedInputCount: 1, acceptedInputCount: 0 },
      error: { code: "computer_focus_not_granted", message: "Focus could not be confirmed." },
    }), act());
    expect(result.dispatch).toMatchObject({ status: "unknown", requestedInputCount: 1, acceptedInputCount: 0 });
  });
});

test("pre-aborted, expired and closed Windows backends never spawn helpers", async () => {
  const runHelper = vi.fn<typeof runWindowsComputerHelper>();
  const backend = createWindowsComputerBackend(target, { runHelper });
  const signal = AbortSignal.abort();
  expect((await backend.execute(act(), signal)).dispatch?.status).toBe("not_dispatched");
  const expired = act(); if (expired.operation === "act") expired.deadlineEpochMs = Date.now() - 1;
  expect((await backend.execute(expired)).error?.code).toBe("computer_action_expired");
  await backend.close();
  expect((await backend.execute(act())).error?.code).toBe("computer_backend_closed");
  expect(runHelper).not.toHaveBeenCalled();
});

test("WSL targets keep their selected native executable and exact physical request", async () => {
  const runHelper = vi.fn<typeof runWindowsComputerHelper>().mockResolvedValue(completed({ desktop, windows: [] }));
  const backend = createWindowsComputerBackend(target, { runHelper });
  await backend.execute({ operation: "inspect" });
  expect(runHelper).toHaveBeenCalledOnce();
  expect(runHelper.mock.calls[0]?.[0]).toMatchObject({ executable: target.shell, request: { operation: "inspect" } });
  await backend.close();
});

test("closing an active backend aborts its helper and never resubmits it", async () => {
  const runHelper = vi.fn<typeof runWindowsComputerHelper>().mockImplementation(({ signal }) => new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve({ status: "aborted", stdout: "", spawned: true }), { once: true });
  }));
  const backend = createWindowsComputerBackend(target, { runHelper });
  const pending = backend.execute(act());
  await backend.close();
  expect((await pending).dispatch?.status).toBe("unknown");
  expect(runHelper).toHaveBeenCalledOnce();
});
