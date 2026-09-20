import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeSetupGateway } from "../../web-ui/runtime-setup-gateway.js";
import { processDebugLogger } from "../observability/debug-logger.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
let gateway: RuntimeSetupGateway;
let gatewayUrl: string;
let port: number;
let external: Server | undefined;

async function listen(server: Server, targetPort = 0): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(targetPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function savedModel(model: string): Promise<void> {
  const path = join(dirname(fixture.configPath), "models/default.config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.model = model;
  await writeFile(path, JSON.stringify(config));
}

async function expectActiveModel(model: string): Promise<void> {
  const response = await fetch(`${gatewayUrl}/models`, {
    headers: { Connection: "close" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ profiles: [{ model }] });
}

beforeEach(async () => {
  const reservation = createServer();
  await listen(reservation);
  port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  gatewayUrl = `http://127.0.0.1:${port}`;
  vi.stubEnv("MODEL_GATEWAY_URL", gatewayUrl);
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-second-review-20260908/gateway-rollback",
  );
  gateway = new RuntimeSetupGateway({ rootDir: fixture.rootDir });
});

afterEach(async () => {
  await gateway.close();
  if (external?.listening)
    await new Promise<void>((resolve) => external!.close(() => resolve()));
  external = undefined;
  processDebugLogger.reset();
  await fixture.cleanup();
});

describe("Web-owned gateway restoration", () => {
  test("restores the previous compiled model policy without rereading saved files", async () => {
    await gateway.activate(fixture.configPath);
    const previous = gateway.createRestorePoint();
    await savedModel("changed-model");
    await gateway.activate(fixture.configPath);
    await expectActiveModel("changed-model");

    // Even invalid current files cannot alter the captured gateway handlers.
    await fixture.writeConfig({ models: {} });
    await previous.restore();
    await previous.restore();
    await expectActiveModel("fixture-chat");
  });

  test("restores once after candidate listen failure and shares that outcome with Apply", async () => {
    await gateway.activate(fixture.configPath);
    const previous = gateway.createRestorePoint();
    await savedModel("changed-model");
    const failure = new Error("candidate_listen_failed");
    const listens = vi.spyOn(Server.prototype, "listen");
    listens.mockImplementationOnce(function (this: Server) {
      queueMicrotask(() => this.emit("error", failure));
      return this;
    });

    await expect(gateway.activate(fixture.configPath)).rejects.toBe(failure);
    expect(listens).toHaveBeenCalledTimes(2);
    await previous.restore();
    expect(listens).toHaveBeenCalledTimes(2);
    await expectActiveModel("fixture-chat");

    // A later explicit Apply has a new restoration lifetime.
    const next = gateway.createRestorePoint();
    await gateway.activate(fixture.configPath);
    await expectActiveModel("changed-model");
    await next.restore();
    await expectActiveModel("fixture-chat");
  });

  test("reports failed restoration without retrying or stopping a competing listener", async () => {
    await gateway.activate(fixture.configPath);
    const previous = gateway.createRestorePoint();
    const failure = new Error("candidate_listen_failed");
    const listens = vi.spyOn(Server.prototype, "listen");
    listens.mockImplementationOnce(function (this: Server) {
      external = createServer((_request, response) => response.end("external"));
      void listen(external, port).then(
        () => this.emit("error", failure),
        (error: unknown) => this.emit("error", error),
      );
      return this;
    });

    const result = await gateway
      .activate(fixture.configPath)
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    const errors = (result as AggregateError).errors;
    expect(errors[0]).toBe(failure);
    expect(errors[1]).toMatchObject({ code: "EADDRINUSE" });
    const attemptedListens = listens.mock.calls.length;
    await expect(previous.restore()).rejects.toBe(errors[1]);
    expect(listens).toHaveBeenCalledTimes(attemptedListens);
    await gateway.close();
    expect(await (await fetch(gatewayUrl)).text()).toBe("external");
  });

  test("restoring the initially empty state removes only the new owned gateway", async () => {
    const empty = gateway.createRestorePoint();
    await gateway.activate(fixture.configPath);
    await expectActiveModel("fixture-chat");
    await empty.restore();
    await empty.restore();
    await expect(fetch(gatewayUrl)).rejects.toThrow();
  });

  test("a late external-gateway refusal leaves the previous listener intact", async () => {
    await gateway.activate(fixture.configPath);
    const previous = gateway.createRestorePoint();
    external = createServer((_request, response) => response.end("external"));
    await listen(external);
    const externalPort = (external.address() as AddressInfo).port;
    vi.stubEnv("MODEL_GATEWAY_URL", `http://127.0.0.1:${externalPort}`);
    expect(await gateway.activate(fixture.configPath)).toMatchObject({
      status: "restart_required",
    });
    await previous.restore();
    await expectActiveModel("fixture-chat");
    expect(await (await fetch(`http://127.0.0.1:${externalPort}`)).text()).toBe(
      "external",
    );
  });
});

test("shutdown during the address check cannot start a new gateway", async () => {
  let release!: () => void;
  let entered!: () => void;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(gateway, "checkActivation").mockImplementationOnce(async () => {
    entered();
    await proceed;
    return { status: "ready" };
  });
  const listens = vi.spyOn(Server.prototype, "listen");
  const activation = gateway.activate(fixture.configPath);
  await checking;
  const closing = gateway.close();
  release();
  await expect(activation).rejects.toThrow("setup_gateway_closed");
  await closing;
  expect(listens).not.toHaveBeenCalled();
});

test.each(["activation", "restoration"] as const)(
  "shutdown after %s binds cannot leave or resurrect a listener",
  async (operation) => {
    await gateway.activate(fixture.configPath);
    const previous = gateway.createRestorePoint();
    if (operation === "restoration") {
      await savedModel("changed-model");
      await gateway.activate(fixture.configPath);
    }
    const originalListen = Server.prototype.listen as (
      this: Server,
      port: number,
      host: string,
      ready: () => void,
    ) => Server;
    let closing: Promise<void> | undefined;
    const listens = vi.spyOn(Server.prototype, "listen");
    listens.mockImplementationOnce(function (this: Server, ...args: unknown[]) {
      const ready = args[2] as () => void;
      originalListen.call(this, args[0] as number, args[1] as string, () => {
        closing = gateway.close();
        ready();
      });
      return this;
    });
    const pending =
      operation === "restoration"
        ? previous.restore()
        : gateway.activate(fixture.configPath);
    await expect(pending).rejects.toThrow("setup_gateway_closed");
    await closing;
    expect(listens).toHaveBeenCalledTimes(1);
    await expect(fetch(gatewayUrl)).rejects.toThrow();
  },
);
