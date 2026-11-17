import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { createSystemHandlers } from "../../computer-access/handlers.js";
import { systemApplicationResult } from "../../computer-access/application-observation.js";
import { attachHostEvidence } from "../../computer-access/host-evidence.js";
import { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { HostConnection } from "../../computer-access/companion/connection.js";
import { startHostBroker } from "../../computer-access/companion/broker-server.js";
import { readBrokerLocation } from "../../computer-access/companion/broker-location.js";
import { executeHostOperation, readHostStatus } from "../../computer-access/companion/broker-client.js";
import { connectNativeHost } from "../../computer-access/companion/native-session.js";
import { createNativeResultBudget } from "../../computer-access/companion/native-result-budget.js";
import { brokerResultBudget } from "../../computer-access/companion/broker-result-budget.js";
import { HOST_WIRE_MAX_BYTES } from "../../computer-access/companion/protocol.js";
import { HOST_SECRET_PROTECTION_CAPABILITY } from "../../computer-access/companion/secret-protection-protocol.js";
import { systemResultProtection } from "../../computer-access/security/system-results.js";
import { createBoundSystemHandlers } from "../../../plugins/system/source/host-dispatch.js";
import { selectedSystemModules } from "./support/system-request-plugin-fixture.js";
import { createRegisteredToolResultBudget } from "../adapters/registered-tool-normal-invocations/execution/result-budget.js";
import { captureRegisteredToolResult } from "../adapters/registered-tool-worker-capabilities/result-evidence.js";
import { projectToolExecutionResult } from "../../capabilities/tool-result-normalization.js";
import { createToolRegistry } from "../../capabilities/registry.js";
import { buildToolCompletedEventActions } from "../../capabilities/tool-event-metadata.js";
import { normalizeCapabilityAdapterResult } from "../orchestration/capability-adapters/result.js";
import type { ToolImplementationOutput } from "../../plugin-sdk/index.js";
import type { SystemApplication, SystemProcessResult, SystemProcessRunner } from "../../computer-access/contracts.js";

const target = { id: "windows" as const, transport: "native" as const, shell: "observed-powershell.exe" };
const identity = { os: "windows" as const, name: "Budget host", user: "test", homeDir: "C:\\Users\\test" };
const scope = { source: "windows_start_apps" as const, roots: [], includesExecutableSearch: false as const, includesOtherTargets: false as const };
const call = { tool: "system_applications", params: { target: "windows", limit: 1 } };
const selectedReferences = [
  { kind: "tool_target" as const, target: 'C:\\Observed\\שלום-"catalog' },
  { kind: "tool_target" as const, target: "C:\\Other\\🚀-catalog" },
];
const scratchRoots = new Set<string>();
afterEach(async () => {
  await Promise.all([...scratchRoots].map((root) => rm(root, { recursive: true, force: true })));
  scratchRoots.clear();
});
function completed(value: unknown): SystemProcessResult {
  return { status: "completed", exitCode: 0, stdout: JSON.stringify(value), stderr: "", outputTruncated: false };
}
function present(application: SystemApplication) {
  return systemApplicationResult(target, { complete: true, scope, applications: [application] }, "", 1,
    { observedMatches: 1, omittedMatches: 0, applications: [application] });
}
function applications(result: ToolImplementationOutput): SystemApplication[] {
  return result.data!.applications as SystemApplication[];
}

test.each(["provenance", "broker", "registered"] as const)("optional metadata survives the complete Companion chain when %s is the first tighter boundary", async (boundary) => {
  const registry = createToolRegistry({ modules: selectedSystemModules(["system_applications"]) });
  const definition = registry.getByName("system_applications")!;
  const registeredBudget = createRegisteredToolResultBudget({ call, definition, selectedReferences });
  const path = `C:\\Observed\\${"x".repeat(384)}\\app.exe`;
  let application: SystemApplication = { id: "Exact.Identity", name: "n".repeat(10_000), target: "windows",
    executableResolution: { status: "resolved", source: "windows_apps_folder_target", path } };
  const initial = present(application);
  const initialHost = attachHostEvidence(initial, "private-host", identity);
  let initialBytes = registeredBudget.assess(initialHost).envelopeBytes!;
  if (boundary === "provenance") initialBytes = createNativeResultBudget(randomUUID()).assess(initial).envelopeBytes!;
  if (boundary === "broker") initialBytes = brokerResultBudget.assess(initialHost).envelopeBytes!;
  const desiredBytes = HOST_WIRE_MAX_BYTES + (boundary === "provenance" ? 0 : 1);
  application = { ...application, name: application.name + "n".repeat(desiredBytes - initialBytes) };
  const nativeResult = present(application);
  expect(nativeResult.ok).toBe(true);
  expect(createNativeResultBudget(randomUUID()).assess(nativeResult).fits).toBe(true);
  if (boundary === "provenance") {
    expect(attachHostEvidence(nativeResult, "private-host", identity).errorCode).toBe("plugin_result_too_large");
  } else {
    const hostResult = attachHostEvidence(nativeResult, "private-host", identity);
    expect(hostResult.ok).toBe(true);
    expect(brokerResultBudget.assess(hostResult).fits).toBe(boundary === "registered");
    if (boundary === "registered") expect(registeredBudget.assess(hostResult).fits).toBe(false);
  }
  const parent = process.platform === "darwin" ? "/private/tmp" : await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "abot-app-budget-"));
  scratchRoots.add(root);
  const store = new HostPairingStore(root);
  const grant = store.consume(store.begin().code, identity);
  const connection = new HostConnection(store);
  const originalExecute = connection.execute.bind(connection);
  const hostReceipts: ToolImplementationOutput[] = [];
  vi.spyOn(connection, "execute").mockImplementation(async (input) => {
    const result = await originalExecute(input);
    hostReceipts.push(result);
    return result;
  });
  const nativeReceipts: ToolImplementationOutput[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: HOST_WIRE_MAX_BYTES });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  server.on("connection", (socket, request) => {
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.type === "result") {
        expect(Buffer.byteLength(bytes.toString(), "utf8")).toBeLessThanOrEqual(HOST_WIRE_MAX_BYTES);
        nativeReceipts.push(message.result);
      }
    });
    connection.accept(socket, request.headers.authorization!.slice("Bearer ".length));
  });
  const broker = await startHostBroker(root, connection, async () => async () => {});
  const brokerSocketDirectory = dirname(readBrokerLocation(root)!.socketPath);
  const stop = new AbortController();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const run = vi.fn<SystemProcessRunner>()
    .mockResolvedValueOnce(completed([{ Name: application.name, AppID: application.id }]))
    .mockResolvedValueOnce(completed([{ id: application.id, status: "resolved", path }]));
  const session = connectNativeHost({
    url: `http://127.0.0.1:${address.port}`, authorization: grant.credential, hostId: grant.hostId, identity,
    signal: stop.signal, handlers: createSystemHandlers(run, async () => target, undefined, systemResultProtection),
    notifications: { ready: false, handlers: () => ({}), close: async () => {} },
    onPaired: async () => { throw new Error("Unexpected pairing"); }, onReady: markReady,
  });
  try {
    await Promise.race([ready, session.then(() => { throw new Error("Session ended before readiness"); })]);
    const status = await readHostStatus(root);
    expect(status.connected).toBe(true);
    const brokerReceipts: ToolImplementationOutput[] = [];
    const wire = { readHostStatus, executeHostOperation: async (...args: Parameters<typeof executeHostOperation>) => {
      const result = await executeHostOperation(...args);
      brokerReceipts.push(result);
      return result;
    } };
    // The injected native handler uses the production protection policy; custom test handlers omit handshake capability advertising.
    const handler = createBoundSystemHandlers({ rootDir: root, connection: wire, nativeHandlers: {}, snapshot: [{
      kind: "companion", target: "windows", hostId: grant.hostId, connectionId: status.connectionId!, identity,
      capabilities: [HOST_SECRET_PROTECTION_CAPABILITY],
    }] }).system_applications!;
    const delivered = await handler(call.params, boundary === "registered" ? { resultBudget: registeredBudget } : undefined);
    expect(nativeReceipts).toHaveLength(1);
    expect(applications(nativeReceipts[0]!)[0]!.executableResolution?.status).toBe("resolved");
    expect(applications(hostReceipts[0]!)[0]!.executableResolution?.status).toBe(boundary === "provenance" ? "unresolved" : "resolved");
    expect(applications(brokerReceipts[0]!)[0]!.executableResolution?.status).toBe(boundary === "registered" ? "resolved" : "unresolved");
    expect(delivered).toMatchObject({ ok: true, data: { transport: "host_companion", nativeTransport: "native",
      catalogComplete: true, observedMatches: 1, omittedMatches: 0, applications: [{ id: application.id, name: application.name,
        executableResolution: { status: "unresolved", reason: "output_budget_exceeded" } }] } });
    expect(delivered.output.startsWith(initialHost.output.slice(0, -initial.output.length))).toBe(true);
    expect(brokerResultBudget.assess(brokerReceipts[0]!).fits).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    if (boundary === "registered") {
      expect(registeredBudget.assess(delivered).fits).toBe(true);
      const result = projectToolExecutionResult(call.tool, delivered);
      const completionActions = buildToolCompletedEventActions(call, result, definition);
      const exact = captureRegisteredToolResult({ status: "executed", effect: "read_only", result, completionActions }, selectedReferences);
      expect(normalizeCapabilityAdapterResult(JSON.parse(JSON.stringify(exact))).ok).toBe(true);
      expect(exact.references).toEqual(expect.arrayContaining(selectedReferences));
    }
  } finally {
    stop.abort();
    await session;
    connection.close();
    await broker.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    scratchRoots.delete(root);
    await rm(brokerSocketDirectory, { recursive: true, force: true });
  }
}, 15_000);
