import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";
import { createRuntimeProjectService } from "../projects/service.js";
import { createProjectFixture } from "./support/project-fixture.js";

for (const kind of ["file", "memory"] as const) {
  describe(`${kind} project session persistence`, () => {
    test("stores canonical binding before any request and retains it across clear", async () => {
      const fixture = await createProjectFixture();
      try {
        const base =
          kind === "file"
            ? createFileSessionStore({
                sessionsDir: fixture.config.paths.sessionsDir,
              })
            : createInMemorySessionStore();
        const sessions = createSessionLifecycleStore(base).store;
        const service = createRuntimeProjectService(fixture.config, sessions);
        const project = await service.create({
          directory: fixture.directories[2]!,
          name: "Project A",
        });
        expect(await service.list()).toEqual([project]);
        expect(await sessions.getAllSessions()).toEqual([]);
        const result = await service.createSession(project.id);
        expect(
          (await sessions.getSessionById(result.sessionId))?.project,
        ).toEqual(result.project);
        expect(
          (await sessions.getSessionSnapshot(result.sessionId))?.messages,
        ).toEqual([]);
        await sessions.appendMessage(result.sessionId, "user", "hello");
        await sessions.clearSessionMessages(result.sessionId);
        expect((await sessions.listSessions()).sessions[0]?.project).toEqual(
          result.project,
        );
        expect(
          (await sessions.getSessionSnapshot(result.sessionId))?.project,
        ).toEqual(result.project);
        await expect(
          sessions.getOrCreateSession(result.sessionId, {
            project: { ...result.project, directory: fixture.directories[3]! },
          }),
        ).rejects.toThrow("session_project_binding_immutable");
        await sessions.getOrCreateSession("ordinary");
        await expect(
          sessions.getOrCreateSession("ordinary", { project: result.project }),
        ).rejects.toThrow("session_project_binding_immutable");
        expect(
          (await sessions.getSessionById("ordinary"))?.project,
        ).toBeUndefined();
        if (kind === "file") {
          const reloaded = createFileSessionStore({
            sessionsDir: fixture.config.paths.sessionsDir,
          });
          expect(
            (await reloaded.getSessionById(result.sessionId))?.project,
          ).toEqual(result.project);
        }
        await sessions.deleteSession(result.sessionId);
        expect(await service.list()).toEqual([project]);
      } finally {
        await fixture.close();
      }
    });
  });
}

describe("project registry and folders", () => {
  test("deduplicates concurrent canonical path creation and survives a service reload", async () => {
    const fixture = await createProjectFixture();
    try {
      const sessions = createInMemorySessionStore();
      const service = createRuntimeProjectService(fixture.config, sessions);
      const projects = await Promise.all(
        ["First", "Second"].map((name) =>
          service.create({ name, directory: fixture.directories[2]! }),
        ),
      );
      expect(projects[0]?.id).toBe(projects[1]?.id);
      expect((await service.list()).length).toBe(1);
      const reloaded = createRuntimeProjectService(fixture.config, sessions);
      expect(await reloaded.list()).toEqual([projects[0]]);
      await expect(
        reloaded.create({ directory: "relative" }),
      ).rejects.toMatchObject({ code: "project_directory_absolute_required" });
      await expect(reloaded.createSession("missing")).rejects.toMatchObject({
        code: "project_not_found",
      });
    } finally {
      await fixture.close();
    }
  });

  test("paginates runtime host folders without limiting project count", async () => {
    const fixture = await createProjectFixture();
    try {
      const directory = fixture.directories[2]!;
      await Promise.all(
        Array.from({ length: 105 }, (_, i) =>
          mkdir(join(directory, `folder-${String(i).padStart(3, "0")}`)),
        ),
      );
      const service = createRuntimeProjectService(
        fixture.config,
        createInMemorySessionStore(),
      );
      const first = await service.browseFolders({ path: directory });
      const next = await service.browseFolders({
        path: directory,
        cursor: first.nextCursor!,
      });
      expect(first.entries).toHaveLength(100);
      expect(next.entries).toHaveLength(5);
      expect(next.nextCursor).toBeNull();
      expect(first.hostPlatform).toBe(process.platform);
      await expect(
        service.browseFolders({ path: directory, cursor: "removed" }),
      ).rejects.toMatchObject({ code: "project_folder_cursor_stale" });
    } finally {
      await fixture.close();
    }
  });
});
