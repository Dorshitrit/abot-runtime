import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { InformationBasketRoutes } from "../../web-ui/local-runtime/information-basket-routes.js";
import { pathSegments, readBody, readJsonBody, requestEnvironmentId, sendJson } from "../../web-ui/local-runtime/http.js";
import { createLocalInformationBasketClient } from "../local-host/client-information-basket.js";
import type { InformationBasketManagement } from "../local-host/client-information-basket.js";
import { dispatchLocalServiceCall } from "../local-host/app-service-dispatch.js";
import { BASKET_LIMITS } from "../information-basket/limits.js";
import type { RuntimeEnvironmentServices } from "../composition.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});
const view = { settings: { revision: 1, enabled: true, embeddingProfileId: "embed" },
  sources: [], embeddingProfiles: [], supportedExtensions: [".txt", ".pdf"],
  limits: { maxSources: 100, maxSourceBytes: 10485760, maxReadCharacters: 12000 } };
function fixtureService() {
  return {
    list: vi.fn(async () => view),
    updateSettings: vi.fn(async () => view),
    addSources: vi.fn(async () => view),
    removeSource: vi.fn(async () => view),
    refreshSource: vi.fn(async () => view),
    relinkSource: vi.fn(async () => view),
    browseFiles: vi.fn(async () => ({ directory: "/home", parent: "/", roots: [],
      entries: [], nextCursor: null, hostPlatform: "linux" as const })),
  } satisfies InformationBasketManagement;
}
async function serve(resolve: (environment: string) => InformationBasketManagement | undefined) {
  const routes = new InformationBasketRoutes(resolve);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const method = request.method ?? "GET";
    const body = method === "GET" ? null : readJsonBody(await readBody(request));
    const handled = await routes.handle({ method, request, response, url, body,
      segments: pathSegments(url.pathname.slice("/web-api".length)),
      environmentId: requestEnvironmentId(url, body, "dev") });
    if (!handled) sendJson(response, 404, { error: "not_found" });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/web-api/runtime/information-basket`;
}
function json(method: string, body: unknown, extra: Record<string, string> = {}) {
  return { method, headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) };
}

test("basket management keeps explicit paths and selected Runtime environment", async () => {
  const dev = fixtureService();
  const prod = fixtureService();
  const base = await serve((id) => id === "prod" ? prod : dev);
  expect(await (await fetch(base)).json()).toMatchObject({ ok: true, ...view });
  const response = await fetch(`${base}?environment=prod`, json("POST", { paths: ["/reports/notes.txt"] }));
  expect(response.status).toBe(201);
  expect(prod.addSources).toHaveBeenCalledWith({ paths: ["/reports/notes.txt"] });
  expect(dev.addSources).not.toHaveBeenCalled();
  expect((await fetch(`${base}/browse?path=%2Freports&cursor=20`)).status).toBe(200);
  expect(dev.browseFiles).toHaveBeenCalledWith({ path: "/reports", cursor: "20" });
});

test("management rejects uploaded bytes, unversioned deletion and cross-origin mutation", async () => {
  const service = fixtureService();
  const base = await serve(() => service);
  for (const body of [{ name: "notes.txt", bytes: "abcd" }, { paths: ["/a"], content: "body" }, { paths: [5] }]) {
    expect((await fetch(base, json("POST", body))).status).toBe(400);
  }
  expect((await fetch(base, json("POST", { paths: ["/a"] }, { origin: "https://foreign.test" }))).status).toBe(403);
  expect((await fetch(`${base}/source-1`, json("DELETE", {}))).status).toBe(400);
  expect((await fetch(base, json("PUT", {}))).status).toBe(405);
  expect((await fetch(`${base}/source-1`, json("DELETE", { expectedRevision: 2 }))).status).toBe(200);
  expect(service.removeSource).toHaveBeenCalledExactlyOnceWith({ sourceId: "source-1", expectedRevision: 2 });
  expect(service.addSources).not.toHaveBeenCalled();
});

test("settings and refresh are revision bound and failures do not expose OS details", async () => {
  const service = fixtureService();
  const base = await serve(() => service);
  expect((await fetch(`${base}/settings`, json("POST", {
    expectedRevision: 1, enabled: true, embeddingProfileId: "embedding",
  }))).status).toBe(200);
  expect(service.updateSettings).toHaveBeenCalledWith({ expectedRevision: 1, enabled: true, embeddingProfileId: "embedding" });
  service.refreshSource.mockRejectedValueOnce(Object.assign(new Error("secret OS details"), { code: "basket_revision_conflict" }));
  const response = await fetch(`${base}/source-1/reindex`, json("POST", { expectedRevision: 1 }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ ok: false, error: "basket_revision_conflict" });
  const unavailable = await serve(() => undefined);
  expect((await fetch(unavailable)).status).toBe(503);
});

test("local RPC exposes management only and broadcasts committed invalidations", async () => {
  const service = fixtureService();
  const services = { informationBasket: service } as unknown as RuntimeEnvironmentServices;
  const client = createLocalInformationBasketClient((method, args) => dispatchLocalServiceCall(services, method, args));
  expect(await client.service.list()).toEqual(view);
  await client.service.addSources({ paths: ["/notes.txt"] });
  expect(service.addSources).toHaveBeenCalledWith({ paths: ["/notes.txt"] });
  for (const method of ["search", "readSource", "stop", "constructor", "list.extra"])
    await expect(dispatchLocalServiceCall(services, `informationBasket.${method}`, [])).rejects.toThrow("local_runtime_method_unknown");
  const notified = vi.fn();
  const unsubscribe = client.subscribe(notified);
  client.receive({ type: "other" });
  client.receive({ type: "information-basket.changed" });
  expect(notified).toHaveBeenCalledTimes(1);
  unsubscribe();
  client.receive({ type: "information-basket.changed" });
  expect(notified).toHaveBeenCalledTimes(1);
});


test("folder selection accepts one atomic batch up to the basket capacity", async () => {
  const service = fixtureService();
  const base = await serve(() => service);
  const paths = Array.from({ length: BASKET_LIMITS.maxSources }, (_, index) => `/reports/source-${index}.txt`);
  expect((await fetch(base, json("POST", { paths }))).status).toBe(201);
  expect(service.addSources).toHaveBeenCalledExactlyOnceWith({ paths });
  expect((await fetch(base, json("POST", { paths: [...paths, "/reports/overflow.txt"] }))).status).toBe(400);
  expect(service.addSources).toHaveBeenCalledOnce();
});


test("relink routes only an explicit versioned path through the selected Runtime management RPC", async () => {
  const service = fixtureService();
  const services = { informationBasket: service } as unknown as RuntimeEnvironmentServices;
  const client = createLocalInformationBasketClient((method, args) => dispatchLocalServiceCall(services, method, args));
  const resolve = vi.fn((environment: string) => environment === "prod" ? client.service : undefined);
  const base = await serve(resolve);
  const response = await fetch(`${base}/source-1/relink?environment=prod`, json("POST", { expectedRevision: 7, path: "/reports/replacement.txt" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, ...view });
  expect(service.relinkSource).toHaveBeenCalledExactlyOnceWith({ sourceId: "source-1", expectedRevision: 7, path: "/reports/replacement.txt" });
  expect(resolve).toHaveBeenCalledWith("prod");
  expect(service.addSources).not.toHaveBeenCalled();
  expect(service.removeSource).not.toHaveBeenCalled();
});

test("relink rejects invalid bodies and cross-origin writes and preserves stable conflict errors", async () => {
  const service = fixtureService();
  const base = await serve(() => service);
  const target = `${base}/source-1/relink`;
  for (const body of [
    {}, { expectedRevision: 1 }, { expectedRevision: 0, path: "/new.txt" },
    { expectedRevision: 1, path: 123 }, { expectedRevision: 1, path: "" },
    { expectedRevision: 1, path: "x".repeat(4097) }, { expectedRevision: 1, path: "bad\0path" },
    { expectedRevision: 1, path: "/new.txt", bytes: "not accepted" },
  ]) expect((await fetch(target, json("POST", body))).status).toBe(400);
  expect((await fetch(target, json("POST", { expectedRevision: 1, path: "/new.txt" }, { origin: "https://foreign.test" }))).status).toBe(403);
  expect((await fetch(target)).status).toBe(405);
  expect(service.relinkSource).not.toHaveBeenCalled();
  service.relinkSource.mockRejectedValueOnce(Object.assign(new Error("private OS path"), { code: "basket_source_path_conflict" }));
  const response = await fetch(target, json("POST", { expectedRevision: 1, path: "/new.txt" }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ ok: false, error: "basket_source_path_conflict" });
});
