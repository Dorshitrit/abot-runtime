import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { createCompanionComputerBackend } from "../../computer-access/computer/companion-backend.js";
import { COMPUTER_FRAME_CHUNK_BYTES } from "../../computer-access/computer/native-validation.js";
import { acceptedDispatch, companionAct, companionHarness, companionImageFixture, companionObservation } from "./computer-companion-fixtures.js";

afterEach(() => vi.restoreAllMocks());

test("transfers a valid PNG above 256KiB through bounded chunks bound to the exact connection", async () => {
  const fills = vi.spyOn(Buffer.prototype, "fill");
  const source = companionImageFixture(), expected = Buffer.from(source);
  expect(source.length).toBeGreaterThan(256 * 1024);
  const harness = companionHarness(companionObservation(source));
  const responses: unknown[] = [];
  const original = harness.connection.executeHostOperation;
  const execute = vi.mocked(harness.connection.executeHostOperation);
  const forward = execute.getMockImplementation()!;
  execute.mockImplementation(async (root, input) => {
    const response = await forward(root, input); responses.push(response); return response;
  });
  const backend = createCompanionComputerBackend("/runtime", harness.route, { ...harness.connection, executeHostOperation: original });
  try {
    const result = await backend.execute({ operation: "observe" });
    expect(result.image?.bytes).toEqual(expected);
    expect(source.every((byte) => byte === 0)).toBe(true);
    const erased = fills.mock.contexts.filter((value) => Buffer.isBuffer(value) && value.length === source.length) as Buffer[];
    expect(erased.length).toBeGreaterThanOrEqual(2);
    expect(erased.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
    expect(createHash("sha256").update(result.image!.bytes).digest("hex"))
      .toBe(createHash("sha256").update(expected).digest("hex"));
    const calls = execute.mock.calls.map(([, input]) => input);
    const chunks = calls.filter((input) => input.operation === "computer_frame");
    expect(chunks.length).toBe(Math.ceil(expected.length / COMPUTER_FRAME_CHUNK_BYTES));
    expect(chunks.map((input) => input.params.offset)).toEqual(chunks.map((_, index) => index * COMPUTER_FRAME_CHUNK_BYTES));
    for (const call of calls) expect(call).toMatchObject({ hostId: harness.route.hostId, connectionId: harness.route.connectionId });
    for (const response of responses) expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(128 * 1024);
    for (const response of responses.slice(1)) {
      const data = (response as { data: { bytes: string } }).data;
      expect(Buffer.from(data.bytes, "base64").length).toBeLessThanOrEqual(COMPUTER_FRAME_CHUNK_BYTES);
    }
  } finally { await backend.close(); await harness.sessions.close(); }
});

test("a corrupted final digest fails image transfer and preserves accepted input", async () => {
  const harness = companionHarness(companionObservation(companionImageFixture(), acceptedDispatch));
  const execute = vi.mocked(harness.connection.executeHostOperation), forward = execute.getMockImplementation()!;
  execute.mockImplementation(async (root, input) => {
    const response = await forward(root, input);
    if (input.operation !== "computer_frame") return response;
    const data = response.data as { bytes: string }, bytes = Buffer.from(data.bytes, "base64");
    bytes[0] = bytes[0]! ^ 1;
    return { ...response, data: { bytes: bytes.toString("base64") } };
  });
  const backend = createCompanionComputerBackend("/runtime", harness.route, harness.connection);
  try {
    const result = await backend.execute(companionAct());
    expect(result.dispatch).toEqual(acceptedDispatch);
    expect(result.error?.code).toBe("computer_frame_transfer_failed");
    expect(result.image).toBeUndefined();
    expect(harness.native.execute).toHaveBeenCalledOnce();
  } finally { await backend.close(); await harness.sessions.close(); }
});

test("foreign session and frame identities cannot retrieve an existing frame", async () => {
  const harness = companionHarness(companionObservation(companionImageFixture()));
  const sessionId = randomUUID();
  try {
    const result = await harness.handlers.computer_execute!({ sessionId, target: "windows", request: { operation: "observe" } });
    const frameId = (result.data as { frame: { id: string } }).frame.id;
    expect((await harness.handlers.computer_frame!({ sessionId: randomUUID(), target: "windows", frameId, offset: 0 })).ok).toBe(false);
    expect((await harness.handlers.computer_frame!({ sessionId, target: "windows", frameId: randomUUID(), offset: 0 })).ok).toBe(false);
    expect((await harness.handlers.computer_frame!({ sessionId, target: "windows", frameId, offset: 0 })).ok).toBe(true);
    expect((await harness.handlers.computer_frame!({ sessionId, target: "windows", frameId, offset: 0 })).ok).toBe(false);
  } finally { await harness.sessions.close(); }
});

test("private close zeroes pending frame bytes and makes the frame inaccessible", async () => {
  const fills = vi.spyOn(Buffer.prototype, "fill");
  const source = companionImageFixture(), length = source.length;
  const harness = companionHarness(companionObservation(source));
  const sessionId = randomUUID();
  try {
    const result = await harness.handlers.computer_execute!({ sessionId, target: "windows", request: { operation: "observe" } });
    const frameId = (result.data as { frame: { id: string } }).frame.id;
    await harness.handlers.computer_close!({ sessionId, target: "windows" });
    expect((await harness.handlers.computer_frame!({ sessionId, target: "windows", frameId, offset: 0 })).ok).toBe(false);
    const erased = fills.mock.contexts.filter((value) => Buffer.isBuffer(value) && value.length === length) as Buffer[];
    expect(erased.length).toBeGreaterThanOrEqual(2);
    expect(erased.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
    expect(harness.native.close).toHaveBeenCalledOnce();
  } finally { await harness.sessions.close(); }
});

test("a malformed frame descriptor cannot erase the accepted native action receipt", async () => {
  const harness = companionHarness();
  const result = companionObservation(undefined, acceptedDispatch);
  vi.mocked(harness.connection.executeHostOperation).mockResolvedValue({
    ok: true, output: "Native action settled.", producedNewInformation: true,
    data: { result, frame: { id: randomUUID(), size: 0, sha256: "invalid" } },
  });
  const backend = createCompanionComputerBackend("/runtime", harness.route, harness.connection);
  try {
    const response = await backend.execute(companionAct());
    expect(response.dispatch).toEqual(acceptedDispatch);
    expect(response.error?.code).toBe("computer_frame_transfer_failed");
    expect(response.image).toBeUndefined();
  } finally { await backend.close(); }
});

test("lost companion connection is not replaced by status discovery or another backend", async () => {
  const harness = companionHarness();
  vi.mocked(harness.connection.executeHostOperation).mockRejectedValue(new Error("connection replaced"));
  const backend = createCompanionComputerBackend("/runtime", harness.route, harness.connection);
  await expect(backend.execute(companionAct())).rejects.toThrow("connection replaced");
  expect(harness.connection.executeHostOperation).toHaveBeenCalledOnce();
  expect(harness.connection.readHostStatus).not.toHaveBeenCalled();
  expect(harness.createBackend).not.toHaveBeenCalled();
  await backend.close();
});
