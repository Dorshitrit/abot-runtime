import { join } from "node:path";
import { expect, test } from "vitest";
import type { RuntimeEnvironmentServices } from "../composition.js";
import { createLocalRuntimeConnection } from "../local-host/transport.js";
import { createLocalServiceClients } from "../local-host/client-services.js";
import { dispatchLocalServiceCall } from "../local-host/app-service-dispatch.js";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";
import { createRuntimeProjectService } from "../projects/service.js";
import { createProjectFixture } from "./support/project-fixture.js";

test("managed service clients share canonical project/session state through owner RPC", async () => {
  const fixture = await createProjectFixture();
  const sessions = createSessionLifecycleStore(
    createFileSessionStore({ sessionsDir: fixture.config.paths.sessionsDir }),
  ).store;
  const projects = createRuntimeProjectService(fixture.config, sessions);
  const services = { sessions, projects } as RuntimeEnvironmentServices;
  const connection = await createLocalRuntimeConnection({
    directory: join(fixture.root, "owner"),
    identity: "project-rpc-test",
    createOwner: async () => ({
      call: (method, args) => dispatchLocalServiceCall(services, method, args),
      subscribe: () => () => undefined,
      stop: async () => undefined,
    }),
  });
  try {
    const client = createLocalServiceClients(connection.call);
    const project = await client.projects.create({
      name: "RPC project",
      directory: fixture.directories[2]!,
    });
    const opened = await client.projects.createSession(project.id);
    expect(await client.projects.get(project.id)).toEqual(project);
    expect(
      (await client.sessions.getSessionById(opened.sessionId))?.project,
    ).toEqual(opened.project);
    expect(
      (await sessions.getSessionSnapshot(opened.sessionId))?.project,
    ).toEqual(opened.project);
    await expect(
      client.projects.createSession("missing"),
    ).rejects.toMatchObject({ code: "project_not_found" });
    await expect(connection.call("projects.constructor", [])).rejects.toThrow(
      "local_runtime_method_unknown",
    );
  } finally {
    await connection.close();
    await fixture.close();
  }
});
