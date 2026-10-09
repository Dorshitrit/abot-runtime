import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { PluginManagementRoutes } from "../../web-ui/local-runtime/plugin-management-routes.js";
import {
  communityArchive,
  pluginSource,
} from "./support/plugin-installation-fixture.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(configured = true) {
  const base = join(
    process.cwd(),
    ".codex/artifacts/plugin-installation-20261006/routes",
  );
  await mkdir(base, { recursive: true });
  const rootDir = await mkdtemp(join(base, "runtime-"));
  roots.push(rootDir);
  if (configured)
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({ plugins: { allow: ["system-probe"] } }),
    );
  const archive = await communityArchive();
  const fetcher = vi.fn(async (url: string) =>
    url.includes("codeload")
      ? new Response(new Uint8Array(archive))
      : new Response(JSON.stringify({ sha: pluginSource.ref })),
  );
  vi.stubGlobal("fetch", fetcher);
  return { routes: new PluginManagementRoutes({ rootDir }), fetcher };
}
async function request(
  routes: PluginManagementRoutes,
  route: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  method = "POST",
) {
  let status = 0;
  let payload: any;
  const response = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (text: string) => {
      payload = JSON.parse(text);
    },
  } as unknown as ServerResponse;
  await routes.handle({
    route,
    method,
    body,
    response,
    request: {
      headers: {
        host: "localhost:5177",
        "content-type": "application/json",
        ...headers,
      },
      socket: {},
    } as IncomingMessage,
  });
  return { status, payload };
}
test("same-origin review and confirmation install through the existing management routes", async () => {
  const { routes, fetcher } = await fixture();
  const inspected = await request(
    routes,
    "runtime/plugins/inspect",
    pluginSource,
  );
  expect(inspected.status).toBe(200);
  expect(inspected.payload.review.source).toEqual(pluginSource);
  const installed = await request(routes, "runtime/plugins/install", {
    source: inspected.payload.review.source,
    digest: inspected.payload.review.digest,
  });
  expect(installed.status).toBe(200);
  expect(installed.payload).toMatchObject({
    ok: true,
    restartRequired: true,
    installed: { id: "community-example" },
  });
  expect(installed.payload.selection.allow).toContain("community-example");
  expect(fetcher).toHaveBeenCalledTimes(4);
});
test.each([
  [{ origin: "https://abot-ai.com" }, 403],
  [{ "sec-fetch-site": "cross-site" }, 403],
  [{ "content-type": "text/plain" }, 415],
] as const)(
  "rejects browser cross-origin writes before downloading: %j",
  async (headers, status) => {
    const { routes, fetcher } = await fixture();
    expect(
      (await request(routes, "runtime/plugins/install", {}, headers)).status,
    ).toBe(status);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
test("installation is unavailable before setup and GET cannot mutate", async () => {
  const { routes, fetcher } = await fixture(false);
  expect(
    (await request(routes, "runtime/plugins/inspect", pluginSource)).status,
  ).toBe(409);
  expect(
    (await request(routes, "runtime/plugins/install", {}, {}, "GET")).status,
  ).toBe(405);
  expect(fetcher).not.toHaveBeenCalled();
});
