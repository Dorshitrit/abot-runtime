import { expect, test, vi } from "vitest";
import { createOperationsController } from "../../web-ui/app/controllers/operations-controller.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

function deferred() {
  let resolve!: (value: Record<string, unknown>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Record<string, unknown>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("status and logs request the selected environment, with explicit capture supported", async () => {
  let environment = "dev one";
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
  const client = createRuntimeWebClient({
    getConfig: () => ({ apiBasePath: "/web-api" }),
    getEnvironmentId: () => environment,
    origin: "http://localhost:5177",
    fetchImpl,
  });
  await client.getRuntimeStatus();
  await client.getRuntimeLogs(100);
  environment = "prod";
  await client.getRuntimeStatus("dev one");
  await client.getRuntimeLogs(20, "dev one");
  await client.getRuntimeStatus();
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    "/web-api/runtime/status?environment=dev%20one",
    "/web-api/runtime/logs?lines=100&environment=dev%20one",
    "/web-api/runtime/status?environment=dev%20one",
    "/web-api/runtime/logs?lines=20&environment=dev%20one",
    "/web-api/runtime/status?environment=prod",
  ]);
});

function harness() {
  let environment = "dev";
  const dom = {
    runtimeStatus: { innerHTML: "", textContent: "" },
    runtimeLogs: { textContent: "" },
    healthStatus: { innerHTML: "", textContent: "" },
  };
  const client = {
    getRuntimeStatus: vi.fn<() => Promise<Record<string, unknown>>>(async () => ({
      status: { config: { traceFile: "prod-trace" } },
    })),
    getRuntimeLogs: vi.fn<() => Promise<Record<string, unknown>>>(async () => ({
      log: { lines: ["prod-log"] },
    })),
    getSystemHealth: vi.fn(async () => ({})),
  };
  const controller = createOperationsController({ dom, client, getEnvironmentId: () => environment });
  return { dom, client, controller, select: (value: string) => { environment = value; } };
}

test.each([false, true])("late status success/error cannot replace another environment (error=%s)", async (reject) => {
  const h = harness();
  const stale = deferred();
  h.client.getRuntimeStatus.mockReturnValueOnce(stale.promise);
  const pending = h.controller.loadRuntimeStatus();
  h.select("prod");
  await h.controller.loadRuntimeStatus();
  if (reject) stale.reject(new Error("dev failure"));
  else stale.resolve({ status: { config: { traceFile: "dev-trace" } } });
  await pending;
  expect(h.dom.runtimeStatus.innerHTML).toContain("prod-trace");
  expect(h.dom.runtimeStatus.innerHTML).not.toContain("dev");
});

test.each([false, true])("late log success/error cannot replace another environment (error=%s)", async (reject) => {
  const h = harness();
  const stale = deferred();
  h.client.getRuntimeLogs.mockReturnValueOnce(stale.promise);
  const pending = h.controller.loadRuntimeLogs();
  h.select("prod");
  await h.controller.loadRuntimeLogs();
  if (reject) stale.reject(new Error("dev failure"));
  else stale.resolve({ log: { lines: ["dev-log"] } });
  await pending;
  expect(h.dom.runtimeLogs.textContent).toBe("prod-log");
});

test("environment changes refresh both projections once without a recurring poll", async () => {
  const h = harness();
  h.select("prod");
  h.controller.environmentChanged();
  h.controller.environmentChanged();
  await Promise.resolve();
  expect(h.client.getRuntimeStatus).toHaveBeenCalledExactlyOnceWith("prod");
  expect(h.client.getRuntimeLogs).toHaveBeenCalledExactlyOnceWith(100, "prod");
  expect(h.dom.runtimeStatus.innerHTML).toContain("prod-trace");
  expect(h.dom.runtimeLogs.textContent).toBe("prod-log");
});
