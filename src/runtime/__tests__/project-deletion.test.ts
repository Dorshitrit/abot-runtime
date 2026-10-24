import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createRuntimeProjectService } from "../projects/service.js";
import { readProjectCatalog } from "../projects/registry-format.js";
import { resolveSessionWorkingDirectory } from "../projects/session-paths.js";
import { createProjectFixture } from "./support/project-fixture.js";

test("deleting a project preserves conversations, original workdir and files across reload", async () => {
  const fixture = await createProjectFixture();
  try {
    const sessions = createFileSessionStore({ sessionsDir: fixture.config.paths.sessionsDir });
    const projects = createRuntimeProjectService(fixture.config, sessions);
    const project = await projects.create({ name: "Keep files", directory: fixture.directories[2]! });
    const opened = await projects.createSession(project.id);
    await sessions.appendMessage(opened.sessionId, "user", "Existing conversation");
    const marker = join(project.directory, "keep.txt");
    await writeFile(marker, "preserved", "utf8");
    const before = await sessions.getSessionById(opened.sessionId);

    await projects.delete(project.id);
    await projects.delete(project.id);

    const reopenedSessions = createFileSessionStore({ sessionsDir: fixture.config.paths.sessionsDir });
    const reopened = createRuntimeProjectService(fixture.config, reopenedSessions);
    expect(await reopened.list()).toEqual([]);
    expect(await reopened.get(project.id)).toBeNull();
    expect(await reopened.catalog()).toEqual({ projects: [], deletedProjectIds: [project.id] });
    const restored = await reopenedSessions.getSessionById(opened.sessionId);
    expect(restored).toEqual(before);
    expect(resolveSessionWorkingDirectory(restored!)).toBe(project.directory);
    expect(await readFile(marker, "utf8")).toBe("preserved");
    await expect(reopened.createSession(project.id)).rejects.toMatchObject({ code: "project_not_found" });

    const replacement = await reopened.create({ directory: project.directory });
    expect(replacement.id).not.toBe(project.id);
    expect(await reopened.catalog()).toEqual({
      projects: [replacement], deletedProjectIds: [project.id],
    });
    expect((await reopenedSessions.getSessionById(opened.sessionId))?.project?.id).toBe(project.id);
  } finally {
    await fixture.close();
  }
});

test("legacy registries retain active projects when orphan identities are explicitly deleted", async () => {
  const fixture = await createProjectFixture();
  try {
    const sessions = createInMemorySessionStore();
    const projects = createRuntimeProjectService(fixture.config, sessions);
    const active = await projects.create({ directory: fixture.directories[2]! });
    const filename = join(fixture.config.paths.runtimeDir, "projects", "registry.json");
    await writeFile(filename, JSON.stringify([active]), "utf8");
    const historical = { id: "historical-project", name: "Historical", directory: fixture.directories[3]! };
    await sessions.getOrCreateSession("historical-session", { project: historical });
    const before = await sessions.getSessionById("historical-session");
    const reopened = createRuntimeProjectService(fixture.config, sessions);
    expect(await reopened.catalog()).toEqual({ projects: [active], deletedProjectIds: [] });

    await Promise.all([reopened.delete(historical.id), reopened.delete("another-orphan")]);

    expect(await reopened.list()).toEqual([active]);
    expect(await reopened.get(active.id)).toEqual(active);
    expect(await sessions.getSessionById("historical-session")).toEqual(before);
    expect(JSON.parse(await readFile(filename, "utf8"))).toEqual({
      version: 1, projects: [active], deletedProjectIds: [historical.id, "another-orphan"],
    });
    const reloaded = createRuntimeProjectService(fixture.config, sessions);
    expect((await reloaded.catalog()).deletedProjectIds).toEqual([historical.id, "another-orphan"]);
    await expect(reloaded.delete("")).rejects.toMatchObject({ code: "project_id_required" });
    await expect(reloaded.delete("   ")).rejects.toMatchObject({ code: "project_id_required" });
  } finally {
    await fixture.close();
  }
});

test.each([
  null,
  {},
  { version: 2, projects: [], deletedProjectIds: [] },
  { version: 1, projects: {}, deletedProjectIds: [] },
  { version: 1, projects: [], deletedProjectIds: null },
  { version: 1, projects: [], deletedProjectIds: [""] },
  { version: 1, projects: [], deletedProjectIds: ["   "] },
  { version: 1, projects: [], deletedProjectIds: [5] },
  { version: 1, projects: [], deletedProjectIds: ["same", "same"] },
  { version: 1, projects: [], deletedProjectIds: [], unexpected: true },
])("rejects malformed project catalogs: %j", (input) => {
  expect(() => readProjectCatalog(input)).toThrow();
});

test("rejects duplicate or simultaneously active and deleted identities", () => {
  const project = { id: "same", name: "Project", directory: "/work/project", createdAt: "now" };
  expect(() => readProjectCatalog([project, project])).toThrow("project_registry_duplicate_id");
  expect(() => readProjectCatalog({ version: 1, projects: [project], deletedProjectIds: [project.id] }))
    .toThrow("project_registry_active_deleted_conflict");
});

test("serializes project deletion with creation without reviving the old identity", async () => {
  const fixture = await createProjectFixture();
  try {
    const projects = createRuntimeProjectService(fixture.config, createInMemorySessionStore());
    const original = await projects.create({ directory: fixture.directories[2]! });
    const deleting = projects.delete(original.id);
    const creating = projects.create({ directory: original.directory });
    const [, replacement] = await Promise.all([deleting, creating]);
    expect(replacement.id).not.toBe(original.id);
    expect(await projects.catalog()).toEqual({
      projects: [replacement], deletedProjectIds: [original.id],
    });
    const reloaded = createRuntimeProjectService(fixture.config, createInMemorySessionStore());
    expect(await reloaded.catalog()).toEqual(await projects.catalog());
  } finally {
    await fixture.close();
  }
});

test("an invalid saved catalog fails closed without overwriting it", async () => {
  const fixture = await createProjectFixture();
  try {
    const projects = createRuntimeProjectService(fixture.config, createInMemorySessionStore());
    await projects.create({ directory: fixture.directories[2]! });
    const filename = join(fixture.config.paths.runtimeDir, "projects", "registry.json");
    const invalid = JSON.stringify({ version: 99, projects: [], deletedProjectIds: [] });
    await writeFile(filename, invalid, "utf8");
    await expect(projects.catalog()).rejects.toThrow("project_registry_version_invalid");
    await expect(projects.delete("orphan")).rejects.toThrow("project_registry_version_invalid");
    expect(await readFile(filename, "utf8")).toBe(invalid);
  } finally {
    await fixture.close();
  }
});
