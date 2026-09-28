import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { COMPUTER_IMAGE_MAX_BYTES } from "../../computer-access/computer/native-validation.js";
import type { NativeComputerResult } from "../../computer-access/computer/native-protocol.js";
import { acceptedDispatch, companionAct, companionHarness, companionImageFixture, companionObservation, deferred } from "./computer-companion-fixtures.js";

test("closing a queued session prevents it from creating a new native backend", async () => {
  const harness = companionHarness();
  const blocked = deferred<NativeComputerResult>(), started = deferred<void>();
  vi.mocked(harness.native.execute).mockImplementation(async () => { started.resolve(); return blocked.promise; });
  const blockerId = randomUUID(), queuedId = randomUUID();
  const first = harness.handlers.computer_execute!({ sessionId: blockerId, target: "windows", request: { operation: "inspect" } });
  await started.promise;
  const queued = harness.handlers.computer_execute!({ sessionId: queuedId, target: "windows", request: companionAct() });
  await harness.handlers.computer_close!({ sessionId: queuedId, target: "windows" });
  blocked.resolve(companionObservation());
  try {
    await first;
    expect((await queued).ok).toBe(false);
    expect(harness.createBackend).toHaveBeenCalledOnce();
    expect(harness.native.execute).toHaveBeenCalledOnce();
    expect((await harness.handlers.computer_execute!({ sessionId: queuedId, target: "windows", request: { operation: "inspect" } })).ok).toBe(false);
  } finally { await harness.sessions.close(); }
});

test("close during an active native action zeroes its late image while retaining the receipt", async () => {
  const harness = companionHarness();
  const settled = deferred<NativeComputerResult>(), started = deferred<void>();
  vi.mocked(harness.native.execute).mockImplementation(async () => { started.resolve(); return settled.promise; });
  const sessionId = randomUUID(), bytes = companionImageFixture();
  const pending = harness.handlers.computer_execute!({ sessionId, target: "windows", request: companionAct() });
  await started.promise;
  await harness.handlers.computer_close!({ sessionId, target: "windows" });
  settled.resolve(companionObservation(bytes, acceptedDispatch));
  try {
    const response = await pending;
    expect(response.ok).toBe(true);
    const data = response.data as { result: NativeComputerResult; frame?: unknown };
    expect(data.result.dispatch).toEqual(acceptedDispatch);
    expect(data.result.error?.code).toBe("computer_session_closed");
    expect(data.frame).toBeUndefined();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(harness.native.close).toHaveBeenCalledOnce();
  } finally { await harness.sessions.close(); }
});

test("an oversized native image is erased without losing accepted input", async () => {
  const bytes = Buffer.alloc(COMPUTER_IMAGE_MAX_BYTES + 1, 0x81);
  const harness = companionHarness(companionObservation(bytes, acceptedDispatch));
  try {
    const response = await harness.handlers.computer_execute!({ sessionId: randomUUID(), target: "windows", request: companionAct() });
    expect(response.ok).toBe(true);
    const data = response.data as { result: NativeComputerResult; frame?: unknown };
    expect(data.result.dispatch).toEqual(acceptedDispatch);
    expect(data.result.error?.code).toBe("computer_image_limit");
    expect(data.frame).toBeUndefined();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  } finally { await harness.sessions.close(); }
});

test("cancellation after input keeps the receipt and does not publish a frame", async () => {
  const harness = companionHarness();
  const settled = deferred<NativeComputerResult>(), started = deferred<void>();
  vi.mocked(harness.native.execute).mockImplementation(async () => { started.resolve(); return settled.promise; });
  const controller = new AbortController(), bytes = companionImageFixture();
  const pending = harness.handlers.computer_execute!({ sessionId: randomUUID(), target: "windows", request: companionAct() }, { abortSignal: controller.signal });
  await started.promise; controller.abort(); settled.resolve(companionObservation(bytes, acceptedDispatch));
  try {
    const response = await pending;
    const data = response.data as { result: NativeComputerResult; frame?: unknown };
    expect(response.ok).toBe(true);
    expect(data.result.dispatch).toEqual(acceptedDispatch);
    expect(data.result.error?.code).toBe("computer_capture_cancelled");
    expect(data.frame).toBeUndefined();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  } finally { await harness.sessions.close(); }
});

test("closed connection cannot be resurrected by a new session identifier", async () => {
  const harness = companionHarness();
  await harness.sessions.close();
  const result = await harness.handlers.computer_execute!({ sessionId: randomUUID(), target: "windows", request: { operation: "inspect" } });
  expect(result.ok).toBe(false);
  expect(harness.resolveTarget).not.toHaveBeenCalled();
  expect(harness.createBackend).not.toHaveBeenCalled();
});
