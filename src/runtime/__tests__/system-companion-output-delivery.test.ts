import { createHash, randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { createBoundSystemHandlers } from "../../../plugins/system/source/host-dispatch.js";
import { SYSTEM_OUTPUT_CAPABILITY, SYSTEM_OUTPUT_CHUNK_BYTES } from "../../computer-access/companion/command-output-protocol.js";
import type { ComputerAccessConnection } from "../../computer-access/client.js";
import { assessResultEnvelopeBytes } from "../../capabilities/result-budget.js";
import { measureToolContextTextBytes } from "../../capabilities/tool-context-text.js";
import type { ToolImplementationOutput } from "../../plugin-sdk/index.js";

const contextBudget = { acceptsContextText: true as const,
  assess: (result: ToolImplementationOutput) => assessResultEnvelopeBytes({ result }, measureToolContextTextBytes(result)) };
function fixture(stdout = "a".repeat(SYSTEM_OUTPUT_CHUNK_BYTES - 1) + "שלום 🚀".repeat(40_000), stderr = "diagnostic") {
  const streams = { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
  const transfer = { kind: SYSTEM_OUTPUT_CAPABILITY, id: randomUUID(), stdoutBytes: streams.stdout.length, stderrBytes: streams.stderr.length,
    stdoutSha256: createHash("sha256").update(streams.stdout).digest("hex"), stderrSha256: createHash("sha256").update(streams.stderr).digest("hex") };
  const receipt: ToolImplementationOutput = { ok: true, producedNewInformation: true, output: "Command settled.", stdout: "", stderr: "", exitCode: 0,
    data: { outputTransfer: transfer, processStatus: "completed", spawnedProcess: { pid: 1234, pidNamespace: "companion_os" } } };
  const native = vi.fn(async () => receipt);
  const dispatch = vi.fn<ComputerAccessConnection["executeHostOperation"]>(async (_root, call) => {
    if (call.operation === "system_command_capture") return receipt;
    if (call.operation === "system_command_output_close") return { ok: true, producedNewInformation: true, output: "closed" };
    if (call.operation !== "system_command_output") throw new Error("unexpected operation");
    const stream = call.params.stream as "stdout" | "stderr";
    const offset = call.params.offset as number;
    return { ok: true, producedNewInformation: true, output: "chunk", data: { captureId: transfer.id, stream, offset,
      bytes: streams[stream].subarray(offset, offset + SYSTEM_OUTPUT_CHUNK_BYTES).toString("base64") } };
  });
  const route = { kind: "companion" as const, target: "linux" as const, hostId: randomUUID(), connectionId: randomUUID(),
    identity: { os: "linux" as const, name: "fixture", user: "fixture", homeDir: "/fixture" }, capabilities: [SYSTEM_OUTPUT_CAPABILITY] };
  const connection = { readHostStatus: vi.fn<ComputerAccessConnection["readHostStatus"]>(), executeHostOperation: dispatch };
  const create = (capabilities = route.capabilities) => createBoundSystemHandlers({ rootDir: "/fixture", nativeHandlers: { system_command: native },
    snapshot: [{ ...route, capabilities }], connection, outputRetentionMs: 900_000 }).system_command!;
  const execute = (controller?: AbortController, acceptsContext = true) => create()({ target: "linux", cwd: "/fixture", command: "opaque command" },
    { resultBudget: acceptsContext ? contextBudget : undefined, abortSignal: controller?.signal });
  return { stdout, stderr, receipt, transfer, dispatch, route, native, create, execute };
}

test("delivers exact multibyte streams through context text with one command and bounded wire chunks", async () => {
  const f = fixture();
  const result = await f.execute();
  expect(result).toMatchObject({ ok: true, stdout: f.stdout, stderr: f.stderr, exitCode: 0,
    contextTextFields: ["stdout", "stderr"], data: { outputDelivery: "complete", spawnedProcess: { pid: 1234, pidNamespace: "companion_os" } } });
  expect(result.data).not.toHaveProperty("outputTransfer");
  expect(contextBudget.assess(result).fits).toBe(true);
  expect(f.dispatch.mock.calls.filter(([, call]) => call.operation === "system_command_capture")).toHaveLength(1);
  expect(f.dispatch.mock.calls[0]![1].params).toMatchObject({ command: "opaque command", outputRetentionMs: 900_000 });
  for (const [, call] of f.dispatch.mock.calls) expect(call).toMatchObject({ hostId: f.route.hostId, connectionId: f.route.connectionId });
  for (const item of f.dispatch.mock.results) expect(Buffer.byteLength(JSON.stringify(await item.value))).toBeLessThan(256 * 1024);
  expect(f.dispatch.mock.calls.at(-1)![1].operation).toBe("system_command_output_close");
  expect(f.native).not.toHaveBeenCalled();
});

test.each(["captureId", "stream", "offset", "bytes", "length", "digest", "read_failure"] as const)(
  "%s corruption preserves the process receipt and never repeats dispatch", async fault => {
    const f = fixture();
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (root, call) => {
      const part = await normal(root, call);
      if (call.operation !== "system_command_output") return part;
      if (fault === "read_failure") throw new Error("connection lost");
      const changes = { captureId: { captureId: randomUUID() }, stream: { stream: "stderr" }, offset: { offset: 1 },
        bytes: { bytes: "%%%" }, length: { bytes: "YQ==" },
        digest: { bytes: Buffer.alloc(SYSTEM_OUTPUT_CHUNK_BYTES, 98).toString("base64") } };
      return { ...part, data: { ...part.data, ...changes[fault] } };
    });
    const result = await f.execute();
    expect(result).toMatchObject({ ok: false, errorCode: "system_output_delivery_pending", exitCode: 0,
      data: { commandOk: true, outputDelivery: "pending", processStatus: "completed", spawnedProcess: { pid: 1234 } } });
    expect(result.stdout).toBeUndefined();
    expect(f.dispatch.mock.calls.filter(([, c]) => c.operation === "system_command_capture")).toHaveLength(1);
    expect(f.dispatch.mock.calls.at(-1)![1].operation).toBe("system_command_output_close");
    expect(f.native).not.toHaveBeenCalled();
  });

test.each(["missing", "invalid_count", "invalid_digest"])("a %s descriptor keeps the settled receipt", async fault => {
  const f = fixture();
  if (fault === "missing") delete f.receipt.data!.outputTransfer;
  if (fault === "invalid_count") f.transfer.stdoutBytes = -1;
  if (fault === "invalid_digest") f.transfer.stdoutSha256 = "invalid";
  expect(await f.execute()).toMatchObject({ errorCode: "system_output_delivery_pending", data: { spawnedProcess: { pid: 1234 } } });
  expect(f.dispatch).toHaveBeenCalledOnce();
});

test("aborting mid-transfer still closes the capture with an independent cleanup signal", async () => {
  const f = fixture(), controller = new AbortController();
  const normal = f.dispatch.getMockImplementation()!;
  f.dispatch.mockImplementation(async (root, call) => {
    const part = await normal(root, call);
    if (call.operation === "system_command_output") controller.abort();
    return part;
  });
  expect(await f.execute(controller)).toMatchObject({ errorCode: "system_output_delivery_pending", data: { spawnedProcess: { pid: 1234 } } });
  expect(f.dispatch.mock.calls.filter(([, c]) => c.operation === "system_command_output")).toHaveLength(1);
  const close = f.dispatch.mock.calls.at(-1)![1];
  expect(close.operation).toBe("system_command_output_close");
  expect(close.abortSignal).not.toBe(controller.signal);
  expect(close.abortSignal?.aborted).toBe(false);
});

test("delivery rejection by an older host preserves metadata instead of replaying the command", async () => {
  const f = fixture();
  expect(await f.execute(undefined, false)).toMatchObject({ errorCode: "system_output_delivery_pending", exitCode: 0,
    data: { spawnedProcess: { pid: 1234 }, outputDelivery: "pending" } });
  expect(f.dispatch.mock.calls.filter(([, c]) => c.operation === "system_command_capture")).toHaveLength(1);
});

test("cleanup failure does not turn successfully delivered output into a command failure", async () => {
  const f = fixture("small", "");
  const normal = f.dispatch.getMockImplementation()!;
  f.dispatch.mockImplementation(async (root, call) => {
    if (call.operation === "system_command_output_close") throw new Error("closed connection");
    return normal(root, call);
  });
  expect(await f.execute()).toMatchObject({ ok: true, stdout: "small", data: { outputDelivery: "complete" } });
});

test.each(["small", ""])("ordinary output '%s' needs no context-text marker", async text => {
  const f = fixture(text, "");
  const result = await f.execute();
  expect(result).toMatchObject({ ok: true, stdout: text, stderr: "" });
  expect(result.contextTextFields).toBeUndefined();
});

test("a failed command's exit status survives successful stream transfer", async () => {
  const f = fixture("partial", "failed");
  Object.assign(f.receipt, { ok: false, producedNewInformation: false, errorCode: "system_command_failed", exitCode: 7 });
  expect(await f.execute()).toMatchObject({ ok: false, errorCode: "system_command_failed", exitCode: 7, stdout: "partial", stderr: "failed" });
});

test("storage failure preserves the native receipt without attempting stream reads", async () => {
  const f = fixture();
  delete f.receipt.data!.outputTransfer;
  Object.assign(f.receipt, { ok: false, errorCode: "system_output_storage_failed" });
  expect(await f.execute()).toBe(f.receipt);
  expect(f.dispatch).toHaveBeenCalledOnce();
});

test("companions without the capability keep the legacy operation unchanged", async () => {
  const f = fixture();
  f.dispatch.mockResolvedValue(f.receipt);
  expect(await f.create([])({ target: "linux", cwd: "/fixture", command: "legacy" })).toBe(f.receipt);
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith("/fixture", {
    hostId: f.route.hostId, connectionId: f.route.connectionId, operation: "system_command",
    params: { target: "linux", cwd: "/fixture", command: "legacy" },
  });
});
