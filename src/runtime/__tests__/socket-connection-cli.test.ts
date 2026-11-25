import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SocketConnectionManagement, SocketConnectionStatus } from "../socket-connection/contracts.js";

const mocks = vi.hoisted(() => ({
  manage: vi.fn(), configure: vi.fn(), legacy: vi.fn(), ask: vi.fn(), closePrompt: vi.fn(),
}));
vi.mock("../socket-connection/offline.js", () => ({ withSocketConnectionManagement: mocks.manage }));
vi.mock("../config.js", () => ({ loadRuntimeConfig: mocks.configure }));
vi.mock("../../shared/load-dotenv.js", () => ({ loadDotEnvFile: vi.fn() }));
vi.mock("../../bridge/configured-runtime-connection.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../bridge/configured-runtime-connection.js")>(), resolveConfiguredRuntimeConnection: mocks.legacy,
}));
vi.mock("node:readline/promises", () => ({ createInterface: () => ({ question: mocks.ask, close: mocks.closePrompt }) }));
import { runSocketConnectionCli } from "../../cli/socket-connection.js";

const bundle = { runtimeId: "remote-id", agentBridgeUrl: "wss://relay.example/socket", runtimeToken: "private-fixture-secret" };
const status: SocketConnectionStatus = { revision: 8, localEnvironmentId: "dev", remoteRuntimeId: "remote-id",
  serverOrigin: "wss://relay.example", state: "offline", error: null, lastRegisteredAt: null, nextRetryAt: null, source: "managed" };
const client = {
  status: vi.fn(async () => status),
  preview: vi.fn(async () => ({ localEnvironmentId: "dev", remoteRuntimeId: "remote-id", serverOrigin: "wss://relay.example", bindingConfirmationRequired: true })),
  import: vi.fn(async () => status), pause: vi.fn(async () => status), resume: vi.fn(async () => status), forget: vi.fn(async () => status),
};
let directory: string;
let file: string;
let output: string[];
const originalTTY = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));
function terminal(value: boolean) {
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { configurable: true, value });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "abot-cli-socket-"));
  file = join(directory, "bundle.json");
  await writeFile(file, JSON.stringify(bundle), { mode: 0o600 });
  vi.clearAllMocks();
  output = [];
  vi.spyOn(console, "log").mockImplementation(line => { output.push(String(line)); });
  vi.spyOn(console, "warn").mockImplementation(line => { output.push(String(line)); });
  vi.stubEnv("LLM_RUNTIME_WEB_ENVIRONMENT", "");
  mocks.configure.mockImplementation(({ profileId }) => ({ runtimeId: profileId ?? "default-local" }));
  mocks.manage.mockImplementation((_config, operation: (client: SocketConnectionManagement) => Promise<unknown>) => operation(client));
  terminal(false);
});
afterEach(async () => {
  [process.stdin, process.stdout].forEach((stream, index) => {
    if (originalTTY[index]) Object.defineProperty(stream, "isTTY", originalTTY[index]!);
    else Reflect.deleteProperty(stream, "isTTY");
  });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { force: true, recursive: true });
});

test("a separate local environment is previewed and explicitly confirmed before import; only safe fields are printed", async () => {
  await runSocketConnectionCli(["connect", "--environment", "dev", "--file", file, "--yes"]);
  expect(mocks.configure).toHaveBeenCalledWith(expect.objectContaining({ profileId: "dev" }));
  expect(mocks.legacy).toHaveBeenCalledWith({ runtimeId: "dev" }, "default-local", expect.any(String));
  expect(client.preview).toHaveBeenCalledWith(bundle);
  expect(client.import).toHaveBeenCalledWith({ bundle, confirmBinding: true, expectedRevision: 8 });
  expect(output.join("\n")).toContain("wss://relay.example");
  expect(output.join("\n")).toContain("remote-id");
  expect(output.join("\n")).not.toContain(bundle.runtimeToken);
});

test("noninteractive and interactive refusal preserve the existing binding", async () => {
  await expect(runSocketConnectionCli(["connect", "--file", file])).rejects.toThrow("--yes");
  terminal(true);
  mocks.ask.mockResolvedValue("no");
  await runSocketConnectionCli(["connect", "--file", file]);
  await runSocketConnectionCli(["forget"]);
  expect(mocks.closePrompt).toHaveBeenCalledTimes(2);
  expect(client.import).not.toHaveBeenCalled();
  expect(client.forget).not.toHaveBeenCalled();
});

test("approval commits the previewed revision once, reporting a concurrent change without replay", async () => {
  terminal(true);
  mocks.ask.mockResolvedValueOnce("yes");
  client.import.mockRejectedValueOnce(new Error("socket_connection_revision_conflict"));
  await expect(runSocketConnectionCli(["connect", "--file", file])).rejects.toThrow("socket_connection_revision_conflict");
  expect(client.import).toHaveBeenCalledExactlyOnceWith({ bundle, confirmBinding: true, expectedRevision: 8 });
  expect(mocks.manage).toHaveBeenCalledTimes(2);
});

test("status is read-only, and management uses the current revision of the chosen environment", async () => {
  mocks.legacy.mockImplementationOnce(() => { throw new Error(bundle.runtimeToken); });
  await runSocketConnectionCli(["status"]);
  expect(mocks.configure).toHaveBeenCalledWith(expect.objectContaining({ profileId: undefined }));
  expect(mocks.legacy).toHaveBeenCalledWith({ runtimeId: "default-local" }, "default-local", expect.any(String));
  expect(client.import).not.toHaveBeenCalled();
  for (const command of ["pause", "resume", "forget"] as const) {
    await runSocketConnectionCli(command === "forget" ? [command, "--yes"] : [command]);
    expect(client[command]).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 8 });
  }
  expect(output.join("\n")).not.toContain(bundle.runtimeToken);
});

test("unknown flags, repeated arguments and malformed file content are never echoed as errors", async () => {
  for (const args of [
    ["connect", "--token", bundle.runtimeToken], ["pause", "--file", file], ["resume", "--yes"],
    ["connect", "--file", file, "--file", file], ["connect", "--file"],
  ]) {
    await expect(runSocketConnectionCli(args)).rejects.toThrow("abot socket connect");
  }
  await writeFile(file, "{" + bundle.runtimeToken);
  await expect(runSocketConnectionCli(["connect", "--file", file, "--yes"])).rejects.toThrow("runtime_bridge_connection_file_invalid");
  expect(client.import).not.toHaveBeenCalled();
  expect(output.join("\n")).not.toContain(bundle.runtimeToken);
});
