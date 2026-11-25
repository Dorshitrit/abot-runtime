import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";

const exec = promisify(execFile);

type ProbeOptions = {
  consumerDir: string;
  packageDir: string;
  tarballPath: string;
  prepareConsumerConfig: (packageDir: string, consumerDir: string) => Promise<void>;
  reserveLoopbackPort: () => Promise<number>;
};
type Registration = { socket: WebSocket; auth?: string; message: Record<string, unknown> };
type WireResponse = { type: string; ok?: boolean; error?: string; sessions?: { id: string }[];
  data?: { agents?: { id: string; name: string }[]; agent?: { id: string } } };

function packedProbeEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: home, TMP: home, TEMP: home,
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home,
    npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false",
    npm_config_cache: process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ??
      (process.platform === "win32" && process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "npm-cache") : join(homedir(), ".npm")),
  };
}

/** Keep npm's real clean-install and bin-link behavior, with the same locked artifacts as npm ci. */
async function installPackedConsumer(options: ProbeOptions, env: NodeJS.ProcessEnv) {
  const { consumerDir, packageDir, tarballPath } = options;
  const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const sourceLock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const manifest = { name: "packed-bridge-consumer", private: true, dependencies: { [pkg.name]: "file:" + tarballPath } };
  const packages = Object.fromEntries(Object.entries(sourceLock.packages).filter(([path, item]) =>
    path !== "" && !(item as { dev?: boolean }).dev));
  packages[""] = manifest;
  packages["node_modules/" + pkg.name] = { version: pkg.version, resolved: "file:" + tarballPath,
    bin: pkg.bin, dependencies: pkg.dependencies };
  await Promise.all([
    writeFile(join(consumerDir, "package.json"), JSON.stringify(manifest)),
    writeFile(join(consumerDir, "package-lock.json"), JSON.stringify({ name: manifest.name, lockfileVersion: 3, packages })),
  ]);
  execFileSync("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumerDir, env, stdio: "pipe" });
  await options.prepareConsumerConfig(packageDir, consumerDir);
  execFileSync(process.execPath, ["--input-type=module", "--eval",
    'import {createFileSessionStore} from "@abot-ai/runtime/runtime/adapters"; ' +
    'await createFileSessionStore({sessionsDir:".runtime/prod/sessions"}).appendMessage("packed-ordinary","user","Packaged session");'],
  { cwd: consumerDir, env, stdio: "pipe" });
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const due = Date.now() + 15_000;
  while (Date.now() < due) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(40);
  }
  throw new Error("packed bridge timed out waiting for " + label);
}

async function untilWebHealth(url: string): Promise<void> {
  const due = Date.now() + 15_000;
  do {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; }
    catch { /* The new CLI process is still binding the Web listener. */ }
    await delay(50);
  } while (Date.now() < due);
  throw new Error("packed bridge timed out waiting for Web startup");
}

export async function verifyPackedSocketBridge(options: ProbeOptions): Promise<void> {
  const { consumerDir } = options;
  const home = join(consumerDir, "home");
  await mkdir(home, { recursive: true });
  const env = packedProbeEnv(home);
  await installPackedConsumer(options, env);

  let providerCalls = 0;
  const http = createServer((_req, res) => { providerCalls++; res.writeHead(503).end(); });
  const relay = new WebSocketServer({ server: http });
  const registrations: Registration[] = [];
  const responses = new Map<string, WireResponse>();
  let connections = 0;
  relay.on("connection", (socket, request) => {
    connections++;
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "register") {
        registrations.push({ socket, auth: request.headers.authorization, message });
        socket.send(JSON.stringify({ type: "registered", ok: true, agentId: message.agentId }));
      } else if (typeof message.correlationId === "string") {
        responses.set(message.correlationId, message);
      }
    });
  });
  let sequence = 0;
  async function call(socket: WebSocket, type: string, fields: Record<string, unknown>) {
    const correlationId = "packed-" + ++sequence;
    socket.send(JSON.stringify({ type, correlationId, ...fields }));
    const response = await until(() => responses.get(correlationId), type);
    assert.equal(response.type, type.replace(/\.request$/, ".response"));
    assert.equal(response.ok, true, type + " " + String(response.error ?? ""));
    return response;
  }

  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  let child: ReturnType<typeof spawn> | undefined;
  const managedToken = "m".repeat(43);
  let output = "";
  let exit: Promise<unknown> | undefined;
  try {
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const relayOrigin = "127.0.0.1:" + address.port;
    const [webPort, gatewayPort] = await Promise.all([options.reserveLoopbackPort(), options.reserveLoopbackPort()]);
    const configPath = join(consumerDir, "local/runtime.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.modelGatewayUrl = "http://127.0.0.1:" + gatewayPort;
    config.models.providers.provider.baseUrl = "http://" + relayOrigin;
    const bundle = { runtimeId: "prod", agentBridgeUrl: "ws://" + relayOrigin + "/abot/agent-bridge", runtimeToken: "packed-fixture-token" };
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(join(consumerDir, "connection.json"), JSON.stringify(bundle), { mode: 0o600 });
    await writeFile(join(consumerDir, ".env"), "LLM_RUNTIME_CONFIG_FILE=local/runtime.config.json\nAGENT_BRIDGE_CONNECTION_FILE=connection.json\n");
    const remoteId = "Packed-Remote";
    const managed = { ...bundle, runtimeId: remoteId, runtimeToken: managedToken };
    const webOrigin = "http://127.0.0.1:" + webPort;
    async function webAction(action = "", body?: Record<string, unknown>) {
      const response = await fetch(webOrigin + "/web-api/socket-connection" + action + "?environment=prod", {
        method: body ? "POST" : "GET",
        headers: { origin: webOrigin, "content-type": "application/json" },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      assert.ok(!text.includes(bundle.runtimeToken) && !text.includes(managedToken), "connection API exposed a credential");
      assert.equal(response.status, 200, "installed connection API failed: " + action);
      const data = JSON.parse(text);
      assert.equal(data.ok, true);
      return data;
    }
    const runSocket = async (...args: string[]) => {
      const result = await exec("npx", ["--no-install", "abot", "socket", ...args], {
        cwd: consumerDir, env, timeout: 15_000, encoding: "utf8",
      });
      assert.ok(!result.stdout.includes(bundle.runtimeToken) && !result.stderr.includes(bundle.runtimeToken) &&
        !result.stdout.includes(managedToken) && !result.stderr.includes(managedToken),
        "management CLI output must only include public pairing details");
      return result.stdout;
    };
    function launch() {
      child = spawn("npx", ["--no-install", "abot", "start"], { cwd: consumerDir,
        env: { ...env, LLM_RUNTIME_WEB_HOST: "127.0.0.1", LLM_RUNTIME_WEB_PORT: String(webPort) },
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", chunk => { output += String(chunk); });
      child.stderr?.on("data", chunk => { output += String(chunk); });
      exit = once(child, "close");
    }
    async function ownerPid(): Promise<number> {
      const path = join(consumerDir, ".runtime/prod/local-host/endpoint.json");
      return until(async () => {
        try { return (JSON.parse(await readFile(path, "utf8")) as { pid: number }).pid; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }, "installed CLI owner");
    }
    async function stop() {
      process.kill(await ownerPid(), "SIGTERM");
      await until(() => child!.exitCode === 0 ? true : undefined, "clean npx exit");
      await exit;
    }
    const status = (index: number) => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error("packed npx terminated before registration");
      return registrations[index];
    };
    launch();
    for (const index of [0, 1]) {
      const { socket, auth, message } = await until(() => status(index), "registration " + (index + 1));
      assert.equal(auth, "Bearer " + bundle.runtimeToken);
      assert.equal(message.agentId, bundle.runtimeId);
      assert.ok(Array.isArray(message.features) && message.features.includes("agents_v1"));
      const catalog = await call(socket, "agents.list.request", { allowedModes: ["ask"] });
      assert.deepEqual(catalog.data?.agents?.map(agent => [agent.id, agent.name]), [["abot", "ABot"]]);
      const detail = await call(socket, "agents.detail.request", { allowedModes: ["ask"], targetAgentId: "abot" });
      assert.equal(detail.data?.agent?.id, "abot");
      const history = await call(socket, "session.list.request", { limit: 100 });
      assert.deepEqual(history.sessions?.map(session => session.id), ["packed-ordinary"]);
      assert.equal(connections, index + 1, "one transport per registration");
      assert.equal(registrations.length, index + 1, "one registration per connection");
      if (index === 0) socket.close(1012, "fixture reconnect");
    }
    const beforeImport = (await webAction()).connection;
    assert.equal(beforeImport.source, "legacy");
    const preview = (await webAction("/preview", { bundle: managed })).preview;
    assert.deepEqual(preview, { localEnvironmentId: "prod", remoteRuntimeId: remoteId, serverOrigin: new URL(managed.agentBridgeUrl).origin,
      bindingConfirmationRequired: true });
    assert.equal((await webAction()).connection.revision, beforeImport.revision, "preview cannot persist or connect");
    const closed = once(registrations[1]!.socket, "close", { signal: AbortSignal.timeout(10_000) });
    const [forgottenLegacy] = await Promise.all([webAction("/forget", { expectedRevision: beforeImport.revision }), closed]);
    assert.equal(forgottenLegacy.connection.state, "not_configured");
    await stop();
    assert.equal(relay.clients.size, 0);
    assert.equal(connections, 2);

    // Import through the installed CLI while the owner is stopped; no relay or model work may awaken.
    await writeFile(join(consumerDir, "managed.json"), JSON.stringify(managed), { mode: 0o600 });
    const imported = await runSocket("connect", "--file", "managed.json", "--environment", "prod", "--yes");
    assert.ok(imported.includes(remoteId) && imported.includes(relayOrigin));
    await rm(join(consumerDir, "managed.json"));
    assert.ok((await runSocket("pause")).includes("paused"));
    assert.ok((await runSocket("status")).includes("paused"));
    assert.equal(connections, 2);

    launch();
    await Promise.all([untilWebHealth("http://127.0.0.1:" + webPort + "/web-health"), ownerPid()]);
    assert.ok((await runSocket("status")).includes("paused"));
    assert.equal(connections, 2, "saved pause must suppress startup registration");
    await runSocket("resume");
    const resumed = await until(() => status(2), "managed registration after resume");
    assert.equal(resumed.auth, "Bearer " + managedToken);
    assert.equal(resumed.message.agentId, remoteId);
    assert.ok(Array.isArray(resumed.message.features) && resumed.message.features.includes("agents_v1"));
    assert.deepEqual((await call(resumed.socket, "session.list.request", { limit: 100 })).sessions?.map(item => item.id), ["packed-ordinary"]);
    assert.equal((await call(resumed.socket, "agents.detail.request", { allowedModes: ["ask"], targetAgentId: "abot" })).data?.agent?.id, "abot");
    const beforePause = (await webAction()).connection;
    assert.equal(beforePause.remoteRuntimeId, remoteId);
    const closeOnPause = once(resumed.socket, "close", { signal: AbortSignal.timeout(10_000) });
    const [paused] = await Promise.all([webAction("/pause", { expectedRevision: beforePause.revision }), closeOnPause]);
    assert.equal(paused.connection.state, "paused");
    assert.ok(paused.connection.revision > beforePause.revision);
    assert.ok((await runSocket("status")).includes("paused"), "CLI and Web must see the same committed state");
    const active = (await webAction("/resume", { expectedRevision: paused.connection.revision })).connection;
    assert.ok(active.revision > paused.connection.revision);
    const webResumed = await until(() => status(3), "registration after Web resume");
    assert.equal(webResumed.message.agentId, remoteId);
    await stop();

    launch();
    const restarted = await until(() => status(4), "saved managed registration after restart");
    assert.equal(restarted.message.agentId, remoteId);
    assert.equal(restarted.auth, "Bearer " + managedToken);
    const forgotten = once(restarted.socket, "close", { signal: AbortSignal.timeout(10_000) });
    await Promise.all([runSocket("forget", "--yes"), forgotten]);
    assert.ok((await runSocket("status")).includes("not configured"));
    await stop();
    launch();
    await Promise.all([untilWebHealth("http://127.0.0.1:" + webPort + "/web-health"), ownerPid()]);
    assert.ok((await runSocket("status")).includes("not configured"));
    await stop();
    assert.equal(relay.clients.size, 0);
    assert.equal(connections, 5, "forget must suppress the still-valid legacy fallback after restart");
    assert.equal(providerCalls, 0, "read-only bridge operations must not call a provider");
  } catch (error) {
    throw new Error(String(error) + "\nPacked npx abot start output:\n" + output.replaceAll("packed-fixture-token", "[fixture]").replaceAll(managedToken, "[fixture]"), { cause: error });
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-child.pid, "SIGKILL");
    }
    if (exit) await exit;
    for (const peer of relay.clients) peer.terminate();
    await new Promise<void>(resolve => relay.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
}
