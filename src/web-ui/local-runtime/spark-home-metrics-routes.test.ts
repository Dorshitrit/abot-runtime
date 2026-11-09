import type { ServerResponse } from "node:http";
import { expect, test, vi } from "vitest";
import { SparkHomeMetricsRoutes } from "./spark-home-metrics-routes.js";
import type { SystemMetricsSnapshot } from "../system-metrics/contracts.js";
import { createSparkHomeRequests } from "../app/services/runtime-web-client/spark-home.js";

function responseFixture() {
  let status = 0; let payload: Record<string, unknown> = {};
  const headers = new Map<string, string>();
  const response = { setHeader: (key: string, value: string) => headers.set(key, value),
    writeHead: (code: number) => { status = code; }, end: (body: string) => { payload = JSON.parse(body); } } as unknown as ServerResponse;
  return { response, headers, status: () => status, payload: () => payload };
}

test("telemetry is environment-bound, read-only, uncached over HTTP and unrelated routes are untouched", async () => {
  const metrics = { sampledAt: "now" } as SystemMetricsSnapshot;
  const read = vi.fn(async () => metrics);
  const routes = new SparkHomeMetricsRoutes(environment => environment === "dev", { read });
  const f = responseFixture();
  const request = { method: "GET", route: "runtime/spark-home/system-metrics", environmentId: "dev", response: f.response };
  expect(await routes.handle({ ...request, route: "chat/messages" })).toBe(false); expect(read).not.toHaveBeenCalled();
  await routes.handle({ ...request, method: "POST" }); expect(f.status()).toBe(405); expect(read).not.toHaveBeenCalled();
  await routes.handle({ ...request, environmentId: "unknown" }); expect(f.status()).toBe(503); expect(read).not.toHaveBeenCalled();
  await routes.handle(request);
  expect(f.status()).toBe(200); expect(f.payload()).toEqual({ ok: true, metrics });
  expect(f.headers.get("cache-control")).toBe("private, no-store"); expect(read).toHaveBeenCalledOnce();
});

test("collection errors never return cached successful values or private error details", async () => {
  const f = responseFixture();
  const routes = new SparkHomeMetricsRoutes(() => true, { read: vi.fn(async () => { throw new Error("private path"); }) });
  await routes.handle({ method: "GET", route: "runtime/spark-home/system-metrics", environmentId: "dev", response: f.response });
  expect(f.payload()).toEqual({ ok: false, error: "system_metrics_unavailable" });
});

test("browser metrics requests bind environment and abort signal without starting generation or bridge requests", async () => {
  const requestApi = vi.fn(async () => ({ ok: true })); let backend = "runtime";
  const client = createSparkHomeRequests({ requestApi, resolveApiPath: path => path,
    getConfig: () => ({ backend }), getEnvironmentId: () => "dev" });
  const signal = new AbortController().signal;
  await client.getSystemMetrics("prod", { signal });
  expect(requestApi).toHaveBeenCalledExactlyOnceWith("/runtime/spark-home/system-metrics?environment=prod", { signal });
  backend = "bridge"; expect(() => client.getSystemMetrics()).toThrow("local Runtime");
  expect(requestApi).toHaveBeenCalledOnce();
});
