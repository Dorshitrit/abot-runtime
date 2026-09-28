import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startHostBroker } from "../../computer-access/companion/broker-server.js";
import { WebSystemHostService } from "../../web-ui/system-host-service.js";
import { reportHostStartupFailure } from "../../web-ui/system-host-startup-diagnostic.js";

vi.mock("../../computer-access/companion/broker-server.js", () => ({
  startHostBroker: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

test.each([
  "host_broker_requires_linux_runtime",
  "local_runtime_directory_not_private",
  "host_state_directory_invalid",
  "host_state_owner_invalid",
  "host_state_directory_not_private",
  "long_term_memory_store_lock_timeout",
])("preserves the fixed startup failure code %s", (code) => {
  const logging = vi.spyOn(console, "error").mockImplementation(() => {});
  reportHostStartupFailure(new Error(code));
  expect(logging).toHaveBeenCalledExactlyOnceWith({
    event: "host_broker_startup_failed",
    code,
  });
});

test.each(["EACCES", "EADDRINUSE", "EPERM", "ENOENT"])(
  "records OS code %s without the private error details",
  (code) => {
    const logging = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(
      new Error("Access denied: /private/credential"),
      {
        code,
        path: "/private/credential",
        credential: "private-token",
        stack: "private-stack",
      },
    );
    reportHostStartupFailure(failure);
    expect(logging).toHaveBeenCalledExactlyOnceWith({
      event: "host_broker_startup_failed",
      code,
    });
  },
);

test.each([
  new Error("private message with credentials"),
  Object.assign(new Error("private"), { code: "private-token" }),
  new Error("EACCES /private/credential"),
  { code: "private-token", message: "private message", path: "/private" },
  "private-token",
  null,
])("redacts unrecognized startup errors %#", (failure) => {
  const logging = vi.spyOn(console, "error").mockImplementation(() => {});
  reportHostStartupFailure(failure);
  expect(logging).toHaveBeenCalledExactlyOnceWith({
    event: "host_broker_startup_failed",
    code: "host_broker_startup_failed",
  });
});

async function startupFailureFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "host-startup-diagnostic-"));
  const service = new WebSystemHostService(rootDir);
  const server = createServer((request, response) => {
    void service.handleHttp(
      request,
      response,
      "/web-api/runtime/system-host/pairing",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const requestPairing = async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/web-api/runtime/system-host/pairing`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    return { status: response.status, body: await response.json() };
  };
  return {
    service,
    requestPairing,
    async close() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

test("logs once per shared startup attempt and preserves the HTTP failure contract", async () => {
  const logging = vi.spyOn(console, "error").mockImplementation(() => {});
  let rejectStartup!: (error: Error) => void;
  const pendingStartup = new Promise<never>((_resolve, reject) => {
    rejectStartup = reject;
  });
  vi.mocked(startHostBroker).mockReturnValueOnce(pendingStartup);
  const fixture = await startupFailureFixture();
  const handleHttp = vi.spyOn(fixture.service, "handleHttp");
  const failure = Object.assign(new Error("socket contains private-token"), {
    code: "EADDRINUSE",
    path: "/private/socket",
  });
  try {
    const first = fixture.requestPairing();
    const second = fixture.requestPairing();
    await vi.waitFor(() => expect(handleHttp).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(startHostBroker).toHaveBeenCalledOnce());
    rejectStartup(failure);
    const unavailable = {
      status: 503,
      body: {
        ok: false,
        error: "host_connection_unavailable",
        message: "The host connection service could not be started or updated.",
      },
    };
    expect(await first).toEqual(unavailable);
    expect(await second).toEqual(unavailable);
    expect(logging).toHaveBeenCalledExactlyOnceWith({
      event: "host_broker_startup_failed",
      code: "EADDRINUSE",
    });

    vi.mocked(startHostBroker).mockRejectedValueOnce(failure);
    expect(await fixture.requestPairing()).toEqual(unavailable);
    expect(startHostBroker).toHaveBeenCalledTimes(2);
    expect(logging).toHaveBeenCalledTimes(2);
  } finally {
    rejectStartup(failure);
    await fixture.close();
  }
});
