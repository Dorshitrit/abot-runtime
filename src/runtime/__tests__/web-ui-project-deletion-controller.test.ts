import { expect, test, vi } from "vitest";
import { createProjectsController } from "../../web-ui/app/controllers/projects-controller.js";
import type { RuntimeProject } from "../projects/contracts.js";
import { deferredProjectResult, project, projectClient } from "./support/projects-controller-fixture.js";

function fixture() {
  let environmentId = "prod";
  const client = projectClient();
  const confirmAction = vi.fn<() => boolean | Promise<boolean>>(() => true);
  const loadSessions = vi.fn(async () => {});
  const notify = vi.fn();
  const openSession = vi.fn(async () => {});
  const controller = createProjectsController({
    client, confirmAction, loadSessions, notify, openSession,
    getEnvironmentId: () => environmentId, getConversationRevision: () => "active:1",
    prepareConversation: vi.fn(() => true), onChange: vi.fn(),
  });
  return { client, controller, confirmAction, loadSessions, notify, openSession,
    setEnvironment: (value: string) => { environmentId = value; },
  };
}

test("cancellation makes no mutation or session reload", async () => {
  const f = fixture();
  f.confirmAction.mockReturnValue(false);
  expect(await f.controller.deleteProject("first", "Workshop")).toBe(false);
  expect(f.client.deleteProject).not.toHaveBeenCalled();
  expect(f.loadSessions).not.toHaveBeenCalled();
  expect(f.controller.getDeletedProjectIds()).toEqual([]);
});

test("confirmation cannot delete the same id in a newly selected environment", async () => {
  const f = fixture();
  f.confirmAction.mockImplementation(() => { f.setEnvironment("dev"); return true; });
  expect(await f.controller.deleteProject("shared-id")).toBe(false);
  expect(f.client.deleteProject).not.toHaveBeenCalled();
});

test("deletion waits for persistence, removes only its project, and reloads without opening another chat", async () => {
  const f = fixture();
  f.client.listProjects.mockResolvedValueOnce({ projects: [project("first"), project("second")] });
  await f.controller.load();
  const pending = deferredProjectResult<{ ok: true }>();
  f.client.deleteProject.mockReturnValueOnce(pending.promise);
  const deleting = f.controller.deleteProject("first", "Workshop");
  await vi.waitFor(() => expect(f.client.deleteProject).toHaveBeenCalledOnce());
  expect(f.controller.snapshot().busyProjectId).toBe("first");
  expect(f.controller.getDeletedProjectIds()).toEqual([]);
  expect(await f.controller.deleteProject("second")).toBe(false);
  expect(f.client.deleteProject).toHaveBeenCalledExactlyOnceWith("first", "prod");
  pending.resolve({ ok: true });
  expect(await deleting).toBe(true);
  expect(f.controller.snapshot().projects.map(({ id }) => id)).toEqual(["second"]);
  expect(f.controller.getDeletedProjectIds()).toEqual(["first"]);
  expect(f.controller.snapshot().busyProjectId).toBe("");
  expect(f.loadSessions).toHaveBeenCalledOnce();
  expect(f.openSession).not.toHaveBeenCalled();
});

test("failed deletion preserves catalog and membership and reports the server error", async () => {
  const f = fixture();
  f.client.listProjects.mockResolvedValueOnce({ projects: [project("first")] });
  await f.controller.load();
  f.client.deleteProject.mockRejectedValueOnce(new Error("Project removal failed"));
  expect(await f.controller.deleteProject("first")).toBe(false);
  expect(f.controller.snapshot().projects.map(({ id }) => id)).toEqual(["first"]);
  expect(f.controller.getDeletedProjectIds()).toEqual([]);
  expect(f.loadSessions).not.toHaveBeenCalled();
  expect(f.notify).toHaveBeenCalledExactlyOnceWith("Project removal failed", "failed");
  expect(f.controller.snapshot().busyProjectId).toBe("");
});

test("an older catalog response cannot resurrect a deleted project or erase its deletion id", async () => {
  const f = fixture();
  const old = deferredProjectResult<{ projects: RuntimeProject[]; deletedProjectIds: string[] }>();
  f.client.listProjects.mockReturnValueOnce(old.promise);
  const loading = f.controller.load();
  await f.controller.deleteProject("first");
  old.resolve({ projects: [project("first")], deletedProjectIds: [] });
  await loading;
  expect(f.controller.snapshot().projects).toEqual([]);
  expect(f.controller.getDeletedProjectIds()).toEqual(["first"]);
  expect(f.controller.snapshot().loading).toBe(false);
});

test("late deletion cannot affect the new environment's project with the same id", async () => {
  const f = fixture();
  const pending = deferredProjectResult<{ ok: true }>();
  f.client.deleteProject.mockReturnValueOnce(pending.promise);
  const deleting = f.controller.deleteProject("shared-id");
  await vi.waitFor(() => expect(f.client.deleteProject).toHaveBeenCalledOnce());
  f.setEnvironment("dev");
  expect(f.controller.getDeletedProjectIds()).toEqual([]);
  f.client.listProjects.mockResolvedValueOnce({ projects: [project("shared-id")], deletedProjectIds: ["dev-old"] });
  await f.controller.environmentChanged();
  pending.resolve({ ok: true });
  expect(await deleting).toBe(false);
  expect(f.controller.snapshot().projects.map(({ id }) => id)).toEqual(["shared-id"]);
  expect(f.controller.getDeletedProjectIds()).toEqual(["dev-old"]);
  expect(f.loadSessions).not.toHaveBeenCalled();
  expect(f.notify).not.toHaveBeenCalled();
});

test("a conversation refresh failure does not undo a successful project deletion", async () => {
  const f = fixture();
  f.loadSessions.mockRejectedValueOnce(new Error("Refresh unavailable"));
  expect(await f.controller.deleteProject("historical-project")).toBe(true);
  expect(f.controller.getDeletedProjectIds()).toEqual(["historical-project"]);
  expect(f.notify).toHaveBeenCalledWith("Refresh unavailable", "failed");
  expect(await f.controller.deleteProject("historical-project")).toBe(false);
  expect(f.client.deleteProject).toHaveBeenCalledTimes(1);
});

test("catalog deletion ids survive reload and are unavailable outside their environment", async () => {
  const f = fixture();
  f.client.listProjects.mockResolvedValueOnce({ projects: [], deletedProjectIds: ["deleted-earlier"] });
  await f.controller.load();
  expect(f.controller.getDeletedProjectIds()).toEqual(["deleted-earlier"]);
  f.setEnvironment("dev");
  expect(f.controller.getDeletedProjectIds()).toEqual([]);
  await f.controller.environmentChanged();
  expect(f.controller.snapshot().deletedProjectIds).toEqual([]);
});

test.each(["cancel", "environment", "catalog"] as const)("deferred project approval rejects %s changes", async (change) => {
  const f = fixture();
  f.client.listProjects.mockResolvedValueOnce({ projects: [project("first")] });
  await f.controller.load();
  const approval = deferredProjectResult<boolean>();
  f.confirmAction.mockReturnValueOnce(approval.promise);
  const deleting = f.controller.deleteProject("first");
  expect(f.client.deleteProject).not.toHaveBeenCalled();
  if (change === "environment") f.setEnvironment("dev");
  if (change === "catalog") {
    f.client.listProjects.mockResolvedValueOnce({ projects: [{ ...project("first"), name: "Renamed" }] });
    await f.controller.load();
  }
  approval.resolve(change !== "cancel");
  expect(await deleting).toBe(false);
  expect(f.client.deleteProject).not.toHaveBeenCalled();
  expect(f.loadSessions).not.toHaveBeenCalled();
});
