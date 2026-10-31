import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { ProjectChangesRoutes } from "../routes.js";
import { projectChangesFixture } from "./fixture.js";

describe("project changes route authority", () => {
  it("accepts only bounded same-origin GET references and returns stale409", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("file.txt", "one\n"); await fixture.commit(); await fixture.write("file.txt", "two\n");
    const routes = new ProjectChangesRoutes(fixture.environments, () => "dev");
    const server = createServer((request, response) => {
      const path = new URL(request.url!, "http://localhost").pathname.replace(/^\/web-api\//u, "");
      void routes.handle(path, request, response);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
    const root = `http://127.0.0.1:${address.port}/web-api/chat/project-changes`;
    try {
      const valid = await fetch(`${root}?environment=dev&sessionId=session-1`);
      expect(valid.status).toBe(200); expect(valid.headers.get("cache-control")).toBe("private, no-store");
      const { changes } = await valid.json();
      const fileUrl = `${root}/file?environment=dev&sessionId=session-1&fileId=${changes.files[0].id}&revision=${changes.revision}`;
      expect((await fetch(fileUrl)).status).toBe(200);
      await fixture.write("file.txt", "three\n");
      const stale = await fetch(fileUrl); expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ error: "project_changes_stale" });
      expect((await fetch(`${root}?environment=dev&sessionId=session-1&path=../../secret`)).status).toBe(400);
      expect((await fetch(`${root}?environment=dev&sessionId=session-1&sessionId=other`)).status).toBe(400);
      expect((await fetch(`${root}?environment=dev&sessionId=session-1`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${root}?environment=dev&sessionId=session-1`, { headers: { origin: "https://outside.example" } })).status).toBe(403);
      const operationUrl = `${root}/operation?environment=dev&sessionId=session-1&requestId=request-1&executionId=execution-1`;
      expect(await (await fetch(operationUrl)).json()).toMatchObject({ ok: true, change: { status: "unavailable", file: null, preview: null } });
      expect((await fetch(operationUrl + "&path=file.txt")).status).toBe(400);
      expect((await fetch(operationUrl, { method: "POST" })).status).toBe(405);
      expect((await fetch(operationUrl, { headers: { origin: "https://outside.example" } })).status).toBe(403);
    } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
  });
});
