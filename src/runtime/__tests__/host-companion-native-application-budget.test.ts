import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { expect, test, vi } from "vitest";
import { createSystemHandlers } from "../../computer-access/handlers.js";
import { systemApplicationResult } from "../../computer-access/application-observation.js";
import { connectNativeHost } from "../../computer-access/companion/native-session.js";
import { createNativeResultBudget, nativeResultEnvelope } from "../../computer-access/companion/native-result-budget.js";
import { HOST_WIRE_MAX_BYTES, type HostAgentMessage } from "../../computer-access/companion/protocol.js";
import type { SystemApplication, SystemProcessResult, SystemProcessRunner, SystemTarget } from "../../computer-access/contracts.js";
import type { ToolImplementation } from "../../plugin-sdk/index.js";

const target: SystemTarget = { id: "windows", transport: "native", shell: "observed-powershell.exe" };
const scope = { source: "windows_start_apps" as const, roots: [], includesExecutableSearch: false as const, includesOtherTargets: false as const };
type ReceivedResult = { bytes: number; envelope: Extract<HostAgentMessage, { type: "result" }> };
function completed(value: unknown): SystemProcessResult {
  return { status: "completed", exitCode: 0, stdout: JSON.stringify(value), stderr: "", outputTruncated: false };
}

async function withNativeResult(
  handler: ToolImplementation,
  inspect: (result: Promise<ReceivedResult>, cancel: () => void) => Promise<void>,
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  const stop = new AbortController();
  const hostId = randomUUID();
  const id = randomUUID();
  let peer: WebSocket;
  const received = new Promise<ReceivedResult>((resolve) => server.once("connection", (client) => {
    peer = client;
    client.once("message", () => {
      client.send(JSON.stringify({ type: "ready", hostId }));
      client.send(JSON.stringify({ type: "execute", id, hostId, operation: "system_applications", params: { target: "windows", limit: 1 } }));
    });
    client.on("message", (bytes) => {
      const envelope = JSON.parse(bytes.toString());
      if (envelope.type === "result") resolve({ bytes: Buffer.byteLength(bytes.toString(), "utf8"), envelope });
    });
  }));
  const session = connectNativeHost({
    url: `http://127.0.0.1:${address.port}`, authorization: "a".repeat(43), hostId,
    identity: { os: "windows", name: "Budget test", user: "test", homeDir: "C:\\Users\\test" },
    signal: stop.signal, handlers: { system_applications: handler },
    notifications: { ready: false, handlers: () => ({}), close: async () => {} },
    onPaired: async () => { throw new Error("Unexpected pairing"); }, onReady: () => {},
  });
  try {
    await inspect(received, () => peer.send(JSON.stringify({ type: "cancel", id })));
  } finally {
    stop.abort();
    await session;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("native result assessment counts the exact escaped UTF-8 wrapper", () => {
  const id = 'request-"\\-שלום-🚀';
  const result = { ok: true, output: "observed", producedNewInformation: true };
  const assessed = createNativeResultBudget(id).assess(result);
  expect(assessed).toEqual({
    fits: true, maxBytes: HOST_WIRE_MAX_BYTES,
    serializedBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
    envelopeBytes: Buffer.byteLength(JSON.stringify({ type: "result", id, result }), "utf8"),
  });
});

test("native application delivery withholds optional detail before the wire wrapper exceeds its limit", async () => {
  const path = `C:\\${"registered".repeat(390)}\\app.exe`;
  let application: SystemApplication = { id: "Exact.Identity", name: "n".repeat(10_000), target: "windows",
    executableResolution: { status: "resolved", source: "windows_apps_folder_target", path } };
  const present = () => systemApplicationResult(target, { applications: [application], complete: true, scope }, "", 1,
    { observedMatches: 1, omittedMatches: 0, applications: [application] });
  const spare = HOST_WIRE_MAX_BYTES - 16 - Buffer.byteLength(JSON.stringify(present()), "utf8");
  application = { ...application, name: application.name + "n".repeat(spare) };
  const standalone = present();
  expect(standalone.ok).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(standalone), "utf8")).toBeLessThan(HOST_WIRE_MAX_BYTES);
  expect(Buffer.byteLength(JSON.stringify(nativeResultEnvelope(randomUUID(), standalone)), "utf8")).toBeGreaterThan(HOST_WIRE_MAX_BYTES);
  const run = vi.fn<SystemProcessRunner>()
    .mockResolvedValueOnce(completed([{ Name: application.name, AppID: application.id }]))
    .mockResolvedValueOnce(completed([{ id: application.id, status: "resolved", path }]));
  const handler = createSystemHandlers(run, async () => target).system_applications!;
  await withNativeResult(handler, async (result) => {
    const received = await result;
    expect(received.bytes).toBeLessThanOrEqual(HOST_WIRE_MAX_BYTES);
    expect(received.envelope.result).toMatchObject({ ok: true, data: {
      catalogComplete: true, observedMatches: 1, omittedMatches: 0,
      applications: [{ id: application.id, name: application.name, target: "windows", executableResolution: {
        status: "unresolved", source: "windows_apps_folder_target", reason: "output_budget_exceeded",
      } }],
    } });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

test("native cancellation during catalog observation still prevents executable probing", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let markAborted!: () => void;
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const run = vi.fn<SystemProcessRunner>(async () => {
    markStarted();
    await aborted;
    return completed([{ Name: "Observed", AppID: "Exact.Identity" }]);
  });
  const applicationHandler = createSystemHandlers(run, async () => target).system_applications!;
  const handler: ToolImplementation = async (params, context) => {
    context!.abortSignal!.addEventListener("abort", markAborted, { once: true });
    return applicationHandler(params, context);
  };
  await withNativeResult(handler, async (result, cancel) => {
    await started;
    cancel();
    const received = await result;
    expect(received.envelope.result.ok).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });
});
