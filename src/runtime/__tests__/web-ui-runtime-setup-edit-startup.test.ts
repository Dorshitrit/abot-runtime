import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runAbotCli } from "../../cli/abot.js";
import * as webUi from "../../web-ui/server.js";
import { RuntimeSetupError } from "../../web-ui/local-runtime/runtime-setup-input.js";

const mock = vi.hoisted(() => ({
  recover: vi.fn<(rootDir: string) => Promise<void>>(),
  requireSettled: vi.fn<(rootDir: string) => void>(),
  loadEnv: vi.fn(),
  readConfig: vi.fn(),
  constructGateway: vi.fn(),
  activate: vi.fn(async () => ({ status: "ready" })),
  closeGateway: vi.fn(async () => {}),
}));
vi.mock("../../web-ui/local-runtime/runtime-setup-edit-recovery.js", () => ({
  recoverRuntimeSetupEdit: mock.recover,
  requireRuntimeSetupEditSettled: mock.requireSettled,
}));
vi.mock("../../shared/load-dotenv.js", () => ({
  loadDotEnvFile: mock.loadEnv,
}));
vi.mock("../../web-ui/environment-config.js", () => ({
  resolveWebUiEnvironmentConfig: mock.readConfig,
}));
vi.mock("../../web-ui/runtime-setup-gateway.js", () => ({
  RuntimeSetupGateway: class {
    constructor(...args: unknown[]) {
      mock.constructGateway(...args);
    }
    activate = mock.activate;
    close = mock.closeGateway;
  },
}));

const explicitRoot = join(tmpdir(), "abot-connection-edit-startup");
const serverOptions = {
  rootDir: explicitRoot,
  backend: "bridge" as const,
  host: "127.0.0.1",
  port: 0,
};
const priorSignals = {
  SIGINT: new Set(process.listeners("SIGINT")),
  SIGTERM: new Set(process.listeners("SIGTERM")),
};

function recoveryGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function unresolvedEdit() {
  return new RuntimeSetupError(
    "setup_edit_recovery_required",
    "Recover the interrupted connection edit before starting.",
    409,
  );
}

function expectNoConfigurationConsumers() {
  expect(mock.loadEnv).not.toHaveBeenCalled();
  expect(mock.readConfig).not.toHaveBeenCalled();
  expect(mock.constructGateway).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mock.recover.mockResolvedValue(undefined);
  mock.readConfig.mockReturnValue({
    defaultEnvironmentId: "prod",
    environments: [{ id: "prod", label: "prod", isDefault: true }],
  });
  mock.activate.mockResolvedValue({ status: "ready" });
  mock.closeGateway.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!priorSignals[signal].has(listener))
        process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
});

test("abot start waits for recovery before reading credentials or activating the gateway", async () => {
  const gate = recoveryGate();
  mock.recover.mockReturnValueOnce(gate.promise);
  const closeWeb = vi.fn(async () => {});
  const startWeb = vi.spyOn(webUi, "startWebUiServer").mockReturnValue({
    close: closeWeb,
    ready: vi.fn(async () => "http://127.0.0.1:5177/"),
  });
  const running = runAbotCli(["start"]);
  try {
    expect(mock.recover).toHaveBeenCalledWith(process.cwd());
    expectNoConfigurationConsumers();
    expect(startWeb).not.toHaveBeenCalled();
    gate.release();
    await vi.waitFor(() => expect(startWeb).toHaveBeenCalledOnce());
    expect(mock.loadEnv).toHaveBeenCalledWith(join(process.cwd(), ".env"));
    expect(mock.activate).toHaveBeenCalledOnce();
    expect(mock.loadEnv.mock.invocationCallOrder[0]).toBeLessThan(
      mock.constructGateway.mock.invocationCallOrder[0]!,
    );
  } finally {
    gate.release();
    await vi.waitFor(() => expect(startWeb).toHaveBeenCalledOnce());
    const shutdown = process
      .listeners("SIGINT")
      .find((listener) => !priorSignals.SIGINT.has(listener));
    shutdown!("SIGINT");
    await running;
  }
  expect(closeWeb).toHaveBeenCalledOnce();
  expect(mock.closeGateway).toHaveBeenCalledOnce();
});

test("abot start surfaces recovery failure before its gateway fallback can swallow it", async () => {
  const failure = unresolvedEdit();
  mock.recover.mockRejectedValueOnce(failure);
  await expect(runAbotCli(["start"])).rejects.toBe(failure);
  expectNoConfigurationConsumers();
  expect(mock.activate).not.toHaveBeenCalled();
});

test.each(["working directory", "explicit runtime root"])(
  "synchronous Web UI startup blocks an unresolved edit in the %s before consumers run",
  (source) => {
    const failure = unresolvedEdit();
    const unresolvedRoot =
      source === "working directory" ? process.cwd() : explicitRoot;
    mock.requireSettled.mockImplementation((rootDir) => {
      if (rootDir === unresolvedRoot) throw failure;
    });
    expect(() => webUi.startWebUiServer(serverOptions)).toThrow(failure);
    expect(mock.requireSettled).toHaveBeenCalledWith(unresolvedRoot);
    expectNoConfigurationConsumers();
    expect(mock.recover).not.toHaveBeenCalled();
  },
);

test("async Web UI startup recovers the explicit root before reading the existing cwd environment", async () => {
  const gate = recoveryGate();
  mock.recover.mockReturnValueOnce(gate.promise);
  const starting = webUi.startWebUiServerWithRecovery(serverOptions);
  try {
    expect(mock.recover).toHaveBeenCalledWith(explicitRoot);
    expectNoConfigurationConsumers();
    expect(mock.requireSettled).not.toHaveBeenCalled();
    gate.release();
    const handle = await starting;
    expect(mock.requireSettled.mock.calls).toEqual([
      [process.cwd()],
      [explicitRoot],
    ]);
    expect(mock.loadEnv).toHaveBeenCalledWith();
    expect(mock.readConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: explicitRoot,
      }),
    );
    expect(mock.requireSettled.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mock.loadEnv.mock.invocationCallOrder[0]!,
    );
    expect(mock.loadEnv.mock.invocationCallOrder[0]).toBeLessThan(
      mock.readConfig.mock.invocationCallOrder[0]!,
    );
    expect(typeof handle.close).toBe("function");
  } finally {
    gate.release();
    await (await starting).close();
  }
});

test("async Web UI startup rejects failed recovery without reading credentials or config", async () => {
  const failure = unresolvedEdit();
  mock.recover.mockRejectedValueOnce(failure);
  await expect(webUi.startWebUiServerWithRecovery(serverOptions)).rejects.toBe(
    failure,
  );
  expect(mock.requireSettled).not.toHaveBeenCalled();
  expectNoConfigurationConsumers();
});

test("recovering an explicit root does not bypass an unresolved cwd credential edit", async () => {
  const failure = unresolvedEdit();
  mock.requireSettled.mockImplementation((rootDir) => {
    if (rootDir === process.cwd()) throw failure;
  });
  await expect(webUi.startWebUiServerWithRecovery(serverOptions)).rejects.toBe(
    failure,
  );
  expect(mock.recover).toHaveBeenCalledExactlyOnceWith(explicitRoot);
  expectNoConfigurationConsumers();
});

test("without an unresolved edit, direct startup remains synchronous and uses cwd by default", async () => {
  const { rootDir: _explicitRoot, ...options } = serverOptions;
  const handle = webUi.startWebUiServer(options);
  try {
    expect(handle).not.toBeInstanceOf(Promise);
    expect(mock.requireSettled).toHaveBeenCalledExactlyOnceWith(process.cwd());
    expect(mock.recover).not.toHaveBeenCalled();
    expect(mock.readConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: process.cwd(),
      }),
    );
  } finally {
    await handle.close();
  }
});
