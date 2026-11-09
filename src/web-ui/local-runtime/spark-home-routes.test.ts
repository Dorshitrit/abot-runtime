import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SparkHomeSnapshot } from "../../runtime/spark-home/contracts.js";
import { SparkHomeRoutes } from "./spark-home-routes.js";
import { renderSparkHomeDocument } from "./spark-home-document.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture() {
  const states = new Map<string, SparkHomeSnapshot>([
    ["dev", { revision: 0, html: null, updatedAt: null }],
    ["prod", { revision: 4, html: "<h1>Production</h1>", updatedAt: "2026-11-01T09:00:00.000Z" }],
  ]);
  const read = vi.fn(async (id: string) => {
    const state = states.get(id);
    if (!state) throw new Error("private storage path must not reach the client");
    return state;
  });
  const routes = new SparkHomeRoutes((id) => ({ read: () => read(id) }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const matched = await routes.handle({
      method: request.method ?? "GET", route: url.pathname.slice(1),
      environmentId: url.searchParams.get("environment") ?? "dev", request, response,
    });
    if (!matched) { response.writeHead(404); response.end(); }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { states, read, request: (path = "/runtime/spark-home", method = "GET") => fetch(origin + path, { method }) };
}

describe("SPARK HOME read-only HTTP projection", () => {
  test("distinguishes empty and saved screens without exposing HTML in metadata", async () => {
    const f = await fixture();
    expect(await (await f.request()).json()).toEqual({ ok: true, screen: null });
    const response = await f.request("/runtime/spark-home?environment=prod");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      ok: true, screen: { revision: 4, updatedAt: "2026-11-01T09:00:00.000Z" },
    });
    expect(f.states.get("dev")?.revision).toBe(0);
  });

  test("serves only the exact environment revision through the isolated wrapper", async () => {
    const f = await fixture();
    const response = await f.request("/runtime/spark-home/content?environment=prod&revision=4");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const policy = response.headers.get("content-security-policy");
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(response.headers.get("connection-allowlist")).toBe("()");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const document = await response.text();
    expect(document).toContain('sandbox="allow-scripts"');
    expect(document).toContain('srcdoc="&lt;h1&gt;Production&lt;/h1&gt;"');
    expect(document).not.toContain("<h1>Production</h1>");
    const stale = await f.request("/runtime/spark-home/content?environment=prod&revision=3");
    expect(stale.status).toBe(409);
    expect(stale.headers.get("content-type")).toContain("text/html");
    const failure = await stale.text();
    expect(failure).toContain('"kind":"abot.spark-home-load-error","revision":3');
    expect(failure).not.toContain("Production");
    const unavailable = await f.request("/runtime/spark-home/content?environment=missing&revision=4");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toContain('"revision":4');
    expect((await f.request("/runtime/spark-home/content?environment=dev&revision=4")).status).toBe(404);
  });

  test.each(["", "0", "-1", "4x", "1.5", "9007199254740992"])("rejects malformed revision %s before reading content", async (revision) => {
    const f = await fixture();
    expect((await f.request(`/runtime/spark-home/content?revision=${revision}`)).status).toBe(400);
    expect(f.read).not.toHaveBeenCalled();
  });

  test("does not accept browser mutations or expose storage failures", async () => {
    const f = await fixture();
    const mutation = await f.request("/runtime/spark-home", "PUT");
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get("allow")).toBe("GET");
    expect(f.read).not.toHaveBeenCalled();
    const unavailable = await f.request("/runtime/spark-home?environment=missing");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ ok: false, error: "spark_home_unavailable" });
    expect((await f.request("/unrelated")).status).toBe(404);
  });

  test("generated markup cannot break out of the inner srcdoc attribute", () => {
    const html = '\"><\/iframe><script>parent.document.body.textContent="changed"</script><p>&quot; & < >';
    const document = renderSparkHomeDocument(html);
    expect(document.match(/<iframe /g)).toHaveLength(1);
    expect(document.match(/<\/iframe>/g)).toHaveLength(1);
    expect(document).not.toContain("<script>");
    const encoded = document.match(/srcdoc="([^"]*)"/)?.[1];
    const decoded = encoded?.replace(/&quot;/g, '\"').replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(decoded).toBe(html);
  });
});
