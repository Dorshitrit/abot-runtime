import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { ProjectRoutes } from "../../web-ui/local-runtime/project-routes.js";
import { readBody, readJsonBody } from "../../web-ui/local-runtime/http.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createRuntimeProjectService } from "../projects/service.js";
import { createProjectFixture } from "./support/project-fixture.js";

test("project HTTP lifecycle persists empty projects and bound sessions without a model request", async () => {
  const fixture = await createProjectFixture();
  const sessions = createInMemorySessionStore();
  const projects = createRuntimeProjectService(fixture.config, sessions);
  const environment = { services: { projects } } as RuntimeEnvironment;
  const routes = new ProjectRoutes();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, "http://localhost");
      await routes.handle({
        request,
        response,
        url,
        environment,
        method: request.method!,
        segments: url.pathname.split("/").filter(Boolean),
        body:
          request.method === "POST"
            ? readJsonBody(await readBody(request))
            : null,
      });
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, requestOrigin = origin) =>
    fetch(origin + path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: requestOrigin },
      body: JSON.stringify(body),
    });
  try {
    const created = await post("/projects", {
      name: "Folder",
      directory: fixture.directories[2],
    });
    expect(created.status).toBe(201);
    const { project } = await created.json();
    expect((await (await fetch(origin + "/projects")).json()).projects).toEqual(
      [project],
    );
    expect(await sessions.getAllSessions()).toEqual([]);
    const opened = await post(`/projects/${project.id}/sessions`, {});
    expect(opened.status).toBe(201);
    const { sessionId, project: binding } = await opened.json();
    const record = await sessions.getSessionById(sessionId);
    expect(record?.project).toEqual(binding);
    expect(record?.messages).toEqual([]);
    expect(record?.requests).toBeUndefined();
    expect(
      (
        await post(
          "/projects",
          { directory: fixture.directories[3] },
          "https://external.invalid",
        )
      ).status,
    ).toBe(403);
    expect((await projects.list()).length).toBe(1);
    expect((await post("/projects", { directory: "relative" })).status).toBe(
      400,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await fixture.close();
  }
});
