import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { createSparkHomeApi } from "./spark-home-api.js";
import type { SparkHomeRunSnapshot } from "../../runtime/spark-home/generation/contracts.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
async function fixture() {
  const run: SparkHomeRunSnapshot = { runId: "home-r", revision: 1, status: "running", phase: "plan",
    startedAt: "now", updatedAt: "now", screenRevision: null, pendingApproval: null, errorCode: null };
  const generation = {
    start: vi.fn(async (_input: unknown) => run), readRun: vi.fn(async (_input: unknown) => run),
    cancel: vi.fn(async (_input: unknown) => ({ ...run, status: "cancelled" as const })),
    decideApproval: vi.fn(async (_input: unknown) => run),
  };
  const preferences = { read: vi.fn(async () => ({ revision: 2, mode: "dashboard" as const })),
    update: vi.fn(async (_input: unknown) => ({ revision: 3, mode: "spark_home" as const })) };
  const settings = { revision: 3, personalInstructions: "A useful screen", modelProfileId: "ea",
    effectiveModelProfileId: "ea", available: true, reason: null, models: [{ id: "ea", label: "EA" }],
    calibrationRequired: false, schedulingAvailable: false as const };
  const configuration = { read: vi.fn(async () => settings), update: vi.fn(async (_input: unknown) => settings),
    readCalibrationOptions: vi.fn(async () => ({ settingsRevision: 3, effectiveModelProfileId: "ea", options: [] })),
    draftCalibration: vi.fn(async () => ({ settingsRevision: 3, effectiveModelProfileId: "ea", personalInstructions: "Draft" })) };
  const services = vi.fn((environment: string) => {
    if (environment !== "dev") throw new Error("private details");
    return { sparkHomeGeneration: generation, sparkHomePreferences: preferences, sparkHomeSettings: configuration };
  });
  const routes = createSparkHomeApi(services);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const handled = await routes.handle({ method: request.method ?? "GET", route: url.pathname.slice(1), body,
      environmentId: url.searchParams.get("environment") ?? "dev", request, response });
    if (!handled) { response.writeHead(404); response.end(); }
  });
  servers.push(server); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = "GET", body?: unknown, headers = {}) => fetch(origin + path, {
    method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { run, generation, preferences, configuration, services, request };
}

test("manual HOME start/read/approval/cancel reach only the generation service with exact DTOs", async () => {
  const h = await fixture();
  expect((await h.request("/runtime/spark-home/runs", "POST", { expectedSettingsRevision: 3 })).status).toBe(202);
  expect(h.generation.start).toHaveBeenCalledExactlyOnceWith({ expectedSettingsRevision: 3 });
  const read = await h.request("/runtime/spark-home/runs?runId=home-r"); expect((await read.json()).run.runId).toBe("home-r");
  expect(h.generation.readRun).toHaveBeenCalledExactlyOnceWith({ runId: "home-r" });
  await h.request("/runtime/spark-home/runs/approval", "POST", { runId: "home-r", approvalId: "a", approved: true });
  expect(h.generation.decideApproval).toHaveBeenCalledExactlyOnceWith({ runId: "home-r", approvalId: "a", approved: true });
  await h.request("/runtime/spark-home/runs/cancel", "POST", { runId: "home-r" });
  expect(h.generation.cancel).toHaveBeenCalledExactlyOnceWith({ runId: "home-r" });
});

test("untrusted mutations cannot widen HOME controls, supply a palette or cross browser origins", async () => {
  const h = await fixture();
  expect((await h.request("/runtime/spark-home/runs", "POST", { expectedSettingsRevision: 3, palette: "white" })).status).toBe(400);
  expect((await h.request("/runtime/spark-home/runs/approval", "POST", { runId: "r", approvalId: "a", approved: true, controls: {} })).status).toBe(400);
  expect((await h.request("/runtime/spark-home/runs", "POST", { expectedSettingsRevision: 3 }, { origin: "https://other.invalid" })).status).toBe(403);
  expect(h.generation.start).not.toHaveBeenCalled(); expect(h.generation.decideApproval).not.toHaveBeenCalled();
});

test("HOME settings reject deferred schedule fields before calling persistence", async () => {
  const h = await fixture();
  const input = { expectedRevision: 3, personalInstructions: "Updated", modelProfileId: "ea" };
  expect((await h.request("/runtime/spark-home/settings", "PUT", { ...input, enabled: true })).status).toBe(400);
  expect(h.configuration.update).not.toHaveBeenCalled();
  expect((await h.request("/runtime/spark-home/settings", "PUT", input)).status).toBe(200);
  expect(h.configuration.update).toHaveBeenCalledExactlyOnceWith(input);
  expect(h.generation.start).not.toHaveBeenCalled();
});

test("HOME view preference has its own revisioned endpoint, separate from generation settings", async () => {
  const h = await fixture(); const input = { expectedRevision: 2, mode: "spark_home" };
  const response = await h.request("/runtime/spark-home/preferences", "PUT", input);
  expect(await response.json()).toEqual({ ok: true, preferences: { revision: 3, mode: "spark_home" } });
  expect(h.preferences.update).toHaveBeenCalledExactlyOnceWith(input);
  expect(h.configuration.update).not.toHaveBeenCalled(); expect(h.generation.start).not.toHaveBeenCalled();
});

test("model drafting never saves or generates, and ordinary routes are not claimed", async () => {
  const h = await fixture();
  await h.request("/runtime/spark-home/calibration/draft", "POST", { expectedRevision: 3, modelProfileId: "ea", widgetIds: ["calendar"], topics: "", constraints: "" });
  expect(h.configuration.draftCalibration).toHaveBeenCalledOnce();
  expect(h.configuration.update).not.toHaveBeenCalled(); expect(h.generation.start).not.toHaveBeenCalled();
  expect((await h.request("/chat/messages", "POST", { text: "ordinary" })).status).toBe(404);
});
