import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { expect, test } from "vitest";
import { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { HostConnection } from "../../computer-access/companion/connection.js";
import { startHostBroker } from "../../computer-access/companion/broker-server.js";
import { connectNativeHost } from "../../computer-access/companion/native-session.js";
import { executeHostOperation, readHostStatus } from "../../computer-access/companion/broker-client.js";
import { createBoundSystemHandlers } from "../../../plugins/system/source/host-dispatch.js";
import { assessResultEnvelopeBytes } from "../../capabilities/result-budget.js";
import { measureToolContextTextBytes } from "../../capabilities/tool-context-text.js";
import { HOST_OPERATIONS } from "../../computer-access/companion/protocol.js";
import { SYSTEM_OUTPUT_CAPABILITY } from "../../computer-access/companion/command-output-protocol.js";
import { activeSystemCaptures } from "../../computer-access/command-output-retention.js";
import type { ToolImplementationOutput } from "../../plugin-sdk/index.js";

// A real command crosses both transports; no model, service restart or installed companion is used.
test.runIf(process.platform === "linux")("SYSTEM delivers durable output above the transport limit through the authenticated broker and native session", async () => {
  const parent = join(process.cwd(), ".codex/artifacts/companion-output-review-20261006/transport");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-"));
  const identity = { os: "linux" as const, name: "Output transport test", user: "test", homeDir: root };
  const store = new HostPairingStore(root);
  const grant = store.consume(store.begin().code, identity);
  const connection = new HostConnection(store);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 256 * 1024 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  let maxMessageBytes = 0;
  server.on("connection", (socket, request) => {
    socket.on("message", bytes => { maxMessageBytes = Math.max(maxMessageBytes, Buffer.byteLength(bytes.toString())); });
    connection.accept(socket, request.headers.authorization!.slice("Bearer ".length));
  });
  const broker = await startHostBroker(root, connection, async () => async () => {});
  const stop = new AbortController();
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const session = connectNativeHost({ url: `http://127.0.0.1:${address.port}`, authorization: grant.credential,
    hostId: grant.hostId, identity, signal: stop.signal, commandOutputStateDir: join(root, "native"),
    notifications: { ready: false, handlers: () => ({}), close: async () => {} },
    onPaired: async () => { throw new Error("Unexpected pairing"); }, onReady: markReady,
  });
  try {
    await Promise.race([ready, session.then(() => { throw new Error("Session stopped before readiness"); })]);
    const status = await readHostStatus(root);
    expect(status).toMatchObject({ connected: true, capabilities: expect.arrayContaining([SYSTEM_OUTPUT_CAPABILITY]) });
    expect(HOST_OPERATIONS).not.toContain("system_command_capture");
    expect(HOST_OPERATIONS).not.toContain("system_command_output");
    const calls: string[] = [];
    const wire = { readHostStatus, executeHostOperation: async (...args: Parameters<typeof executeHostOperation>) => {
      calls.push(args[1].operation);
      return executeHostOperation(...args);
    } };
    const handler = createBoundSystemHandlers({ rootDir: root, connection: wire, nativeHandlers: {}, outputRetentionMs: 30 * 86_400_000,
      snapshot: [{ kind: "companion", target: "linux", hostId: grant.hostId, connectionId: status.connectionId!, identity, capabilities: status.capabilities }],
    }).system_command!;
    const budget = { acceptsContextText: true as const,
      assess: (result: ToolImplementationOutput) => assessResultEnvelopeBytes({ result }, measureToolContextTextBytes(result)) };
    const stdout = "a".repeat(65_535) + "שלום 🚀\\\"\n".repeat(50_000);
    const stderr = "diagnostic".repeat(12_000);
    const script = join(root, "output.cjs");
    await writeFile(script, `require("fs").appendFileSync("dispatches", "once\\n"); process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});`);
    const result = await handler({ target: "linux", cwd: root, command: `'${process.execPath}' '${script}'` }, { resultBudget: budget });
    expect(result).toMatchObject({ ok: true, stdout, stderr, exitCode: 0, contextTextFields: ["stdout", "stderr"],
      data: { outputDelivery: "complete", spawnedProcess: { pid: expect.any(Number), pidNamespace: "companion_os" }, outputCapture: { retentionMs: 30 * 86_400_000 } } });
    expect(budget.assess(result).fits).toBe(true);
    const capture = result.data!.outputCapture as { id: string };
    const directory = join(root, "native/command-output", capture.id);
    expect(await readFile(join(directory, "stdout.bytes"))).toEqual(Buffer.from(stdout));
    expect(await readFile(join(directory, "stderr.bytes"))).toEqual(Buffer.from(stderr));
    expect(activeSystemCaptures.has(directory)).toBe(false);
    expect(await readFile(join(root, "dispatches"), "utf8")).toBe("once\n");
    expect(maxMessageBytes).toBeLessThan(256 * 1024);
    expect(calls.filter(name => name === "system_command_capture")).toHaveLength(1);
    expect(calls.filter(name => name === "system_command_output").length).toBeGreaterThan(2);
    expect(calls.filter(name => name === "system_command_output_close")).toHaveLength(1);
  } finally {
    stop.abort();
    await session;
    connection.close();
    await broker.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
