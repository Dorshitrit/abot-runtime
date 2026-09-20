import { describe, expect, test } from "vitest";
import type { ProjectFolderPage, RuntimeProject } from "../projects/contracts.js";
import { deferredProjectResult, folderPage, project, projectsControllerFixture } from "./support/projects-controller-fixture.js";

describe("project creation and conversation lifetime", () => {
  test("opening and cancelling a draft makes no conversation or project mutation", async () => {
    const f = projectsControllerFixture();
    const folders = deferredProjectResult<ProjectFolderPage>();
    f.client.browseProjectFolders.mockReturnValueOnce(folders.promise);
    f.controller.openCreate();
    f.controller.updateDraft("name", "unsaved");
    expect(f.controller.closeCreate()).toBe(true);
    folders.resolve(folderPage("/late"));
    await folders.promise;
    expect(f.controller.snapshot().draft).toBeNull();
    expect(f.client.createProject).not.toHaveBeenCalled();
    expect(f.client.createProjectSession).not.toHaveBeenCalled();
    expect(f.prepareConversation).not.toHaveBeenCalled();
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.loadSessions).not.toHaveBeenCalled();
  });

  test("does not open or reload a session when server persistence fails", async () => {
    const f = projectsControllerFixture();
    f.client.createProjectSession.mockRejectedValueOnce(new Error("persistence unavailable"));
    await f.controller.newConversation("project-one");
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.loadSessions).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledWith("persistence unavailable", "failed");
    expect(f.onSessionCreated).not.toHaveBeenCalled();
    expect(f.controller.snapshot().busyProjectId).toBe("");
  });

  test("waits for persistence and refresh before opening the exact returned session", async () => {
    const f = projectsControllerFixture();
    const saved = deferredProjectResult<{ sessionId: string; project: RuntimeProject }>();
    const loaded = deferredProjectResult<void>();
    f.client.createProjectSession.mockReturnValueOnce(saved.promise);
    f.loadSessions.mockReturnValueOnce(loaded.promise);
    const pending = f.controller.newConversation("project-one");
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.loadSessions).not.toHaveBeenCalled();
    saved.resolve({ sessionId: "server-assigned", project: project() });
    await saved.promise;
    expect(f.loadSessions).toHaveBeenCalledOnce();
    expect(f.onSessionCreated).toHaveBeenCalledExactlyOnceWith("server-assigned");
    expect(f.openSession).not.toHaveBeenCalled();
    loaded.resolve();
    await pending;
    expect(f.openSession).toHaveBeenCalledWith("server-assigned");
  });

  test("honors a navigation veto without creating a server session", async () => {
    const f = projectsControllerFixture();
    f.prepareConversation.mockReturnValueOnce(false);
    await f.controller.newConversation("project-one");
    expect(f.client.createProjectSession).not.toHaveBeenCalled();
    expect(f.openSession).not.toHaveBeenCalled();
  });

  test("a late session result does not replace a newly selected conversation", async () => {
    const f = projectsControllerFixture();
    const saved = deferredProjectResult<{ sessionId: string; project: RuntimeProject }>();
    f.client.createProjectSession.mockReturnValueOnce(saved.promise);
    const pending = f.controller.newConversation("project-one");
    f.navigateConversation("another:2");
    saved.resolve({ sessionId: "late-session", project: project() });
    await pending;
    expect(f.onSessionCreated).toHaveBeenCalledExactlyOnceWith("late-session");
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.controller.snapshot().busyProjectId).toBe("");
  });

  test("remembers the created session before ignoring a late result from another environment", async () => {
    const f = projectsControllerFixture();
    const saved = deferredProjectResult<{ sessionId: string; project: RuntimeProject }>();
    f.client.createProjectSession.mockReturnValueOnce(saved.promise);
    const pending = f.controller.newConversation("project-one");
    f.setEnvironment("dev");
    await f.controller.environmentChanged();
    saved.resolve({ sessionId: "background-session", project: project() });
    await pending;
    expect(f.onSessionCreated).toHaveBeenCalledExactlyOnceWith("background-session");
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.loadSessions).not.toHaveBeenCalled();
  });

  test("a late session result or failure from another environment stays out of the current view", async () => {
    const f = projectsControllerFixture();
    const saved = deferredProjectResult<{ sessionId: string; project: RuntimeProject }>();
    f.client.createProjectSession.mockReturnValueOnce(saved.promise);
    const pending = f.controller.newConversation("project-one");
    f.setEnvironment("dev");
    await f.controller.environmentChanged();
    saved.reject(new Error("old environment failure"));
    await pending;
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.loadSessions).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.controller.snapshot().busyProjectId).toBe("");
  });
});

describe("project list and folder races", () => {
  test("only the latest list in the current environment can publish", async () => {
    const f = projectsControllerFixture();
    const old = deferredProjectResult<{ projects: RuntimeProject[] }>();
    f.client.listProjects.mockReturnValueOnce(old.promise);
    const oldLoad = f.controller.load();
    f.setEnvironment("dev");
    f.client.listProjects.mockResolvedValueOnce({ projects: [project("dev-project")] });
    await f.controller.environmentChanged();
    old.resolve({ projects: [project("prod-project")] });
    await oldLoad;
    expect(f.controller.snapshot().projects.map(({ id }) => id)).toEqual(["dev-project"]);
    expect(f.controller.snapshot().loading).toBe(false);
  });

  test("an older same-environment refresh cannot overwrite a newer list", async () => {
    const f = projectsControllerFixture();
    const old = deferredProjectResult<{ projects: RuntimeProject[] }>();
    f.client.listProjects.mockReturnValueOnce(old.promise);
    const oldLoad = f.controller.load();
    f.client.listProjects.mockResolvedValueOnce({ projects: [project("newer")] });
    await f.controller.load();
    old.resolve({ projects: [project("older")] });
    await oldLoad;
    expect(f.controller.snapshot().projects.map(({ id }) => id)).toEqual(["newer"]);
  });

  test("an outstanding list cannot erase a just-created project or leave a spinner", async () => {
    const f = projectsControllerFixture();
    const old = deferredProjectResult<{ projects: RuntimeProject[] }>();
    f.client.listProjects.mockReturnValueOnce(old.promise);
    const oldLoad = f.controller.load();
    f.controller.openCreate();
    await Promise.resolve();
    f.controller.updateDraft("name", " New project ");
    f.controller.updateDraft("directory", " /work/new ");
    await f.controller.create();
    expect(f.client.createProject).toHaveBeenCalledWith({ name: "New project", directory: "/work/new" }, "prod");
    old.resolve({ projects: [] });
    await oldLoad;
    expect(f.controller.snapshot().projects.map(({ id }) => id)).toEqual(["project-one"]);
    expect(f.controller.snapshot().loading).toBe(false);
  });

  test("a stale picker response cannot overwrite a manually entered path", async () => {
    const f = projectsControllerFixture();
    const old = deferredProjectResult<ProjectFolderPage>();
    f.client.browseProjectFolders.mockReturnValueOnce(old.promise);
    f.controller.openCreate();
    const opening = f.controller.openFolderPicker();
    f.controller.updateDraft("directory", "/chosen/Desktop");
    old.resolve(folderPage("/default/home"));
    await opening;
    expect(f.controller.snapshot().draft?.directory).toBe("/chosen/Desktop");
    expect(f.controller.snapshot().draft?.loading).toBe(false);
  });

  test("out-of-order folder pages do not replace the user's newer navigation", async () => {
    const f = projectsControllerFixture();
    f.controller.openCreate();
    await f.controller.openFolderPicker();
    const old = deferredProjectResult<ProjectFolderPage>();
    f.client.browseProjectFolders.mockReturnValueOnce(old.promise);
    const olderBrowse = f.controller.browse("/older");
    f.client.browseProjectFolders.mockResolvedValueOnce(folderPage("/newer"));
    await f.controller.browse("/newer");
    old.resolve(folderPage("/older"));
    await olderBrowse;
    expect(f.controller.snapshot().draft?.listing?.directory).toBe("/newer");
    expect(f.controller.snapshot().draft?.directory).toBe("");
  });

  test("an environment switch invalidates an in-flight create without opening its session", async () => {
    const f = projectsControllerFixture();
    f.controller.openCreate();
    await Promise.resolve();
    const old = deferredProjectResult<{ project: RuntimeProject }>();
    f.client.createProject.mockReturnValueOnce(old.promise);
    const creating = f.controller.create();
    f.setEnvironment("dev");
    await f.controller.environmentChanged();
    old.resolve({ project: project("old-environment-project") });
    await creating;
    expect(f.controller.snapshot().projects).toEqual([]);
    expect(f.controller.snapshot().draft).toBeNull();
    expect(f.client.createProjectSession).not.toHaveBeenCalled();
    expect(f.openSession).not.toHaveBeenCalled();
  });
});
