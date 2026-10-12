import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mock = vi.hoisted(() => ({
  recover: vi.fn<(rootDir: string) => Promise<void>>(),
  readConfig: vi.fn(() => ({ runtimeId: "fixture" })),
  createRuntime: vi.fn(),
  startRuntime: vi.fn(async () => {}),
  startBridge: vi.fn(() => ({ stop: vi.fn(async () => {}) })),
  resolvePort: vi.fn(() => 0),
  createGateway: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("../../web-ui/local-runtime/runtime-setup-edit-recovery.js", () => ({
  recoverRuntimeSetupEdit: mock.recover,
}));
vi.mock("../index.js", () => ({
  loadRuntimeConfig: mock.readConfig,
  createLocalRuntimeApplication: mock.createRuntime,
}));
vi.mock("../../bridge/start-agent-bridge.js", () => ({
  startAgentBridge: mock.startBridge,
}));
vi.mock("../../model-gateway/server/index.js", () => ({
  resolveModelGatewayPort: mock.resolvePort,
  createModelGatewayServer: mock.createGateway,
}));

const originalArgv = [...process.argv];
const priorSignals = {
  SIGINT: new Set(process.listeners("SIGINT")),
  SIGTERM: new Set(process.listeners("SIGTERM")),
};
const entries = [
  {
    name: "runtime dev",
    start: () => import("../../../index.js"),
    prepare: () => {},
    consumer: mock.readConfig,
  },
  {
    name: "standalone model gateway",
    start: () => import("../../model-gateway/server.js"),
    prepare: () => {
      process.argv[1] = fileURLToPath(
        new URL("../../model-gateway/server.ts", import.meta.url),
      );
    },
    consumer: mock.resolvePort,
  },
];

function expectNoConsumers() {
  expect(mock.readConfig).not.toHaveBeenCalled();
  expect(mock.createRuntime).not.toHaveBeenCalled();
  expect(mock.startBridge).not.toHaveBeenCalled();
  expect(mock.resolvePort).not.toHaveBeenCalled();
  expect(mock.createGateway).not.toHaveBeenCalled();
  expect(mock.listen).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.recover.mockResolvedValue(undefined);
  mock.createRuntime.mockReturnValue({
    start: mock.startRuntime,
    stop: vi.fn(async () => {}),
    services: {},
  });
  mock.createGateway.mockReturnValue({ listen: mock.listen });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = [...originalArgv];
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!priorSignals[signal].has(listener))
        process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
});

for (const entry of entries) {
  test(`${entry.name} waits for edit recovery before consuming configuration`, async () => {
    entry.prepare();
    let release!: () => void;
    mock.recover.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const starting = entry.start();
    try {
      await vi.waitFor(() =>
        expect(mock.recover).toHaveBeenCalledExactlyOnceWith(process.cwd()),
      );
      expectNoConsumers();
    } finally {
      release();
      await starting;
    }
    expect(entry.consumer).toHaveBeenCalledOnce();
    expect(mock.recover.mock.invocationCallOrder[0]).toBeLessThan(
      entry.consumer.mock.invocationCallOrder[0]!,
    );
  });

  test(`${entry.name} surfaces failed recovery without starting`, async () => {
    entry.prepare();
    const failure = new Error("Interrupted edit requires recovery");
    mock.recover.mockRejectedValueOnce(failure);
    await expect(entry.start()).rejects.toBe(failure);
    expect(mock.recover).toHaveBeenCalledExactlyOnceWith(process.cwd());
    expectNoConsumers();
  });
}

test("importing the gateway facade does not recover settings or start a server", async () => {
  process.argv[1] = fileURLToPath(
    new URL("./source-setup-edit-startup.test.ts", import.meta.url),
  );
  await import("../../model-gateway/server.js");
  expect(mock.recover).not.toHaveBeenCalled();
  expectNoConsumers();
});
