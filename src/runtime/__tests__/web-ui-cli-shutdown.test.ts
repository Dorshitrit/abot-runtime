import { afterEach, expect, test, vi } from "vitest";
import { runAbotCli } from "../../cli/abot.js";

const handles = vi.hoisted(() => ({
  activate: vi.fn(async () => ({ status: "ready" })),
  closeGateway: vi.fn(async () => {}),
  closeWeb: vi.fn(async () => {}),
  startWeb: vi.fn(),
}));
vi.mock("../../web-ui/runtime-setup-gateway.js", () => ({
  RuntimeSetupGateway: class {
    activate = handles.activate;
    close = handles.closeGateway;
  },
}));
vi.mock("../../web-ui/server.js", () => ({
  startWebUiServer: (...args: unknown[]) => {
    handles.startWeb(...args);
    return { close: handles.closeWeb };
  },
}));
vi.mock("../../shared/load-dotenv.js", () => ({ loadDotEnvFile: vi.fn() }));
const prior = {
  SIGINT: new Set(process.listeners("SIGINT")),
  SIGTERM: new Set(process.listeners("SIGTERM")),
};

afterEach(() => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!prior[signal].has(listener))
        process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test("the CLI shutdown handler closes the gateway even when Web UI close rejects", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const failure = new Error("web_close_failed");
  handles.closeWeb.mockRejectedValueOnce(failure);
  const running = runAbotCli(["start"]);
  const result = running.catch((error) => error);
  await vi.waitFor(() => expect(handles.startWeb).toHaveBeenCalledOnce());
  const shutdown = process
    .listeners("SIGINT")
    .find((listener) => !prior.SIGINT.has(listener))!;
  shutdown("SIGINT");
  expect(await result).toBe(failure);
  expect(handles.closeGateway).toHaveBeenCalledOnce();
  expect(handles.closeWeb).toHaveBeenCalledOnce();
});
