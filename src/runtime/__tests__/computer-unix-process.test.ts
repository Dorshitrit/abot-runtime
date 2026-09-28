import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createUnixNativeProcess } from "../../computer-access/computer/unix-native-process.js";
import { readUnixNativeResult } from "../../computer-access/computer/unix-native-results.js";
import type { NativeComputerRequest } from "../../computer-access/computer/native-protocol.js";

const nativeResult = {
  desktop: {
    platform: "linux",
    binding: "desktop-session",
    name: "Test desktop",
    available: true,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    capabilities: Object.fromEntries(
      ["capture", "input", "windows", "accessibility"].map((key) => [
        key,
        { supported: true, available: true },
      ]),
    ),
    targetingGuarantee: "verified_window",
  },
  windows: [],
};
const action: NativeComputerRequest = {
  operation: "act",
  desktopBinding: "desktop-session",
  expectedGeometry: { x: 0, y: 0, width: 100, height: 100 },
  action: { kind: "click", point: { x: 10, y: 10 }, button: "left", count: 1 },
  deadlineEpochMs: Date.now() + 10_000,
};
const observation = {
  capturedAt: "2026-09-24T00:00:00.000Z",
  region: nativeResult.desktop.bounds,
  imageWidth: 100,
  imageHeight: 100,
  accessibility: [],
  accessibilityTruncated: false,
};

function helper() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const messages: Record<string, unknown>[] = [];
  process.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n"))
      messages.push(JSON.parse(line));
  });
  const spawnProcess = vi.fn(() => process) as unknown as typeof spawn;
  const backend = createUnixNativeProcess({
    platform: "linux",
    file: "fake-interpreter",
    args: [],
    spawnProcess,
    timeoutMs: 200,
    cancellationGraceMs: 5,
  });
  return { process, messages, backend, spawnProcess };
}

describe("Unix desktop helper transport", () => {
  it("retains one process across observations and serializes requests", async () => {
    const test = helper();
    const first = test.backend.execute({ operation: "inspect" });
    const second = test.backend.execute({ operation: "inspect" });
    await Promise.resolve();
    expect(test.messages).toHaveLength(1);
    test.process.stdout.write(
      JSON.stringify({
        type: "result",
        id: test.messages[0]!.id,
        result: nativeResult,
      }) + "\n",
    );
    await first;
    await Promise.resolve();
    expect(test.messages).toHaveLength(2);
    test.process.stdout.write(
      JSON.stringify({
        type: "result",
        id: test.messages[1]!.id,
        result: nativeResult,
      }) + "\n",
    );
    await second;
    expect(test.spawnProcess).toHaveBeenCalledTimes(1);
    await test.backend.close();
  });

  it("does not start a helper for a request already cancelled", async () => {
    const test = helper();
    const controller = new AbortController();
    controller.abort();
    expect(await test.backend.execute(action, controller.signal)).toMatchObject(
      { dispatch: { status: "not_dispatched" } },
    );
    expect(test.spawnProcess).not.toHaveBeenCalled();
    await test.backend.close();
  });

  it("preserves uncertainty and never restarts after a dispatched action loses its process", async () => {
    const test = helper();
    const pending = test.backend.execute(action);
    await Promise.resolve();
    test.process.stdout.write(
      JSON.stringify({
        type: "dispatch",
        id: test.messages[0]!.id,
        dispatch: {
          status: "unknown",
          requestedInputCount: 3,
          reason: "native_dispatch_started",
        },
      }) + "\n",
    );
    test.process.emit("exit", 1);
    expect(await pending).toMatchObject({
      dispatch: { status: "unknown" },
      error: { code: "computer_native_helper_stopped" },
    });
    await test.backend.execute(action);
    expect(test.spawnProcess).toHaveBeenCalledTimes(1);
    expect(test.messages).toHaveLength(1);
    await test.backend.close();
  });

  it("sends cancellation and reports unknown if the helper cannot settle", async () => {
    const test = helper();
    const controller = new AbortController();
    const pending = test.backend.execute(action, controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({
      dispatch: { status: "unknown" },
      error: { code: "computer_native_cancelled_unknown" },
    });
    expect(test.messages[1]).toMatchObject({
      type: "cancel",
      id: test.messages[0]!.id,
    });
    await test.backend.close();
  });

  it("rejects a response for a different operation identity", async () => {
    const test = helper();
    const pending = test.backend.execute({ operation: "inspect" });
    await Promise.resolve();
    test.process.stdout.write(
      JSON.stringify({
        type: "result",
        id: "wrong-operation",
        result: nativeResult,
      }) + "\n",
    );
    expect(await pending).toMatchObject({
      error: { code: "computer_native_protocol_invalid" },
    });
    await test.backend.close();
  });

  it("rejects image bytes without native observation metadata", () => {
    expect(() =>
      readUnixNativeResult(
        {
          ...nativeResult,
          imageBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
            "base64",
          ),
        },
        "linux",
      ),
    ).toThrow("native_image_without_observation");
  });

  it("decodes image bytes separately from canonical metadata", () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const result = readUnixNativeResult(
      { ...nativeResult, observation, imageBase64: bytes.toString("base64") },
      "linux",
    );
    expect(result).toEqual({
      ...nativeResult,
      observation,
      image: { mimeType: "image/png", bytes },
    });
    expect(result).not.toHaveProperty("imageBase64");
  });

  it("enforces canonical window and accessibility count limits", () => {
    const window = {
      binding: "window-one",
      title: "Test",
      bounds: nativeResult.desktop.bounds,
      focused: true,
    };
    expect(() =>
      readUnixNativeResult(
        { ...nativeResult, windows: Array.from({ length: 257 }, () => window) },
        "linux",
      ),
    ).toThrow("Invalid window list.");
    expect(() =>
      readUnixNativeResult(
        {
          ...nativeResult,
          observation: {
            ...observation,
            accessibility: Array.from({ length: 513 }, () => ({
              role: "button",
            })),
          },
        },
        "linux",
      ),
    ).toThrow("Invalid accessibility observation.");
  });

  it("validates accessibility nodes and string bounds through the shared contract", () => {
    for (const node of [
      { role: 1 },
      { role: "button", name: "x".repeat(4097) },
    ]) {
      expect(() =>
        readUnixNativeResult(
          {
            ...nativeResult,
            observation: { ...observation, accessibility: [node] },
          },
          "linux",
        ),
      ).toThrow();
    }
  });

  it("keeps metadata limits separate from image bytes and binds the platform", () => {
    expect(() => readUnixNativeResult(nativeResult, "macos")).toThrow(
      "native_desktop_invalid",
    );
    expect(() =>
      readUnixNativeResult(
        {
          ...nativeResult,
          observation: {
            ...observation,
            accessibility: Array.from({ length: 32 }, () => ({
              role: "text",
              value: "x".repeat(4096),
            })),
          },
        },
        "linux",
      ),
    ).toThrow("Desktop metadata exceeds its limit.");
  });
});
