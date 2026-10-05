import { describe, expect, test, vi } from "vitest";
import { createProjectsController } from "../../web-ui/app/controllers/projects-controller.js";
import type { ProjectFolderPage, RuntimeProject } from "../projects/contracts.js";
import { deferredProjectResult, folderPage, project, projectClient } from "./support/projects-controller-fixture.js";

function fixture(initialReady = true) {
  let ready = initialReady;
  let environment = "prod";
  const client = projectClient();
  const dependencies = {
    client, getEnvironmentId: () => environment, isRuntimeReady: () => ready,
    getConversationRevision: () => "existing:1", prepareConversation: vi.fn(() => true),
    openSession: vi.fn(async (_id: string) => {}), loadSessions: vi.fn(async () => {}),
    onChange: vi.fn(), notify: vi.fn(), onSessionCreated: vi.fn(),
  };
  const controller = createProjectsController(dependencies);
  return { ...dependencies, controller,
    setReady: (value: boolean) => { ready = value; },
    setEnvironment: (value: string) => { environment = value; },
  };
}

function enterDraft(f: ReturnType<typeof fixture>) {
  f.controller.openCreate();
  f.controller.updateDraft("name", "My project");
  f.controller.updateDraft("directory", "/work/project");
}

describe("Projects Runtime readiness lifecycle", () => {
  test("empty onboarding makes no project reads or mutations and loads once when the same environment becomes ready", async () => {
    const f = fixture(false);
    await f.controller.load();
    f.controller.openCreate();
    await f.controller.openFolderPicker();
    await f.controller.create();
    await f.controller.newConversation("project-one");
    expect(f.client.listProjects).not.toHaveBeenCalled();
    expect(f.client.createProject).not.toHaveBeenCalled();
    expect(f.client.browseProjectFolders).not.toHaveBeenCalled();
    expect(f.client.createProjectSession).not.toHaveBeenCalled();
    expect(f.prepareConversation).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ loading: false, error: "", draft: null });
    f.setReady(true);
    f.client.listProjects.mockResolvedValueOnce({ projects: [project("configured")] });
    await f.controller.runtimeAvailabilityChanged();
    await f.controller.runtimeAvailabilityChanged();
    expect(f.client.listProjects).toHaveBeenCalledExactlyOnceWith("prod");
    expect(f.controller.snapshot().projects.map(({ id }) => id)).toEqual(["configured"]);
  });

  test.each(["success", "failure"] as const)("a late %s from before readiness loss cannot replace the refreshed same-environment list", async (outcome) => {
    const f = fixture();
    const old = deferredProjectResult<{ projects: RuntimeProject[] }>();
    f.client.listProjects.mockReturnValueOnce(old.promise);
    const pending = f.controller.load();
    f.setReady(false);
    await f.controller.runtimeAvailabilityChanged();
    expect(f.controller.snapshot()).toMatchObject({ projects: [], loading: false, error: "" });
    f.setReady(true);
    f.client.listProjects.mockResolvedValueOnce({ projects: [project("fresh")] });
    await f.controller.runtimeAvailabilityChanged();
    if (outcome === "success") old.resolve({ projects: [project("stale")] });
    else old.reject(new Error("Invalid runtime config: requestRunner.configRef is required"));
    await pending;
    expect(f.controller.snapshot()).toMatchObject({ projects: [project("fresh")], error: "", loading: false });
  });

  test("an ordinary list failure still exposes Retry and a refresh preserves an unsaved draft", async () => {
    const f = fixture();
    enterDraft(f);
    const draft = f.controller.snapshot().draft;
    f.client.listProjects.mockRejectedValueOnce(new Error("project storage unavailable"));
    await f.controller.load();
    expect(f.controller.snapshot().error).toBe("project storage unavailable");
    expect(f.controller.snapshot().draft).toBe(draft);
    await f.controller.runtimeAvailabilityChanged();
    expect(f.client.listProjects).toHaveBeenCalledOnce();
    await f.controller.load();
    expect(f.client.listProjects).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot()).toMatchObject({ error: "", draft: { name: "My project", directory: "/work/project" } });
  });

  test.each(["success", "failure"] as const)("readiness loss preserves draft input and discards a late folder %s", async (outcome) => {
    const f = fixture();
    enterDraft(f);
    const old = deferredProjectResult<ProjectFolderPage>();
    f.client.browseProjectFolders.mockReturnValueOnce(old.promise);
    const pending = f.controller.openFolderPicker();
    f.setReady(false);
    await f.controller.runtimeAvailabilityChanged();
    await f.controller.create();
    await f.controller.browse("/unavailable");
    expect(f.client.createProject).not.toHaveBeenCalled();
    expect(f.client.browseProjectFolders).toHaveBeenCalledOnce();
    f.setReady(true);
    await f.controller.runtimeAvailabilityChanged();
    if (outcome === "success") old.resolve(folderPage("/old"));
    else old.reject(new Error("old folder error"));
    await pending;
    expect(f.controller.snapshot().draft).toMatchObject({ name: "My project", directory: "/work/project",
      loading: false, saving: false, pickerOpen: false, listing: null, error: "" });
    await f.controller.openFolderPicker();
    expect(f.controller.snapshot().draft?.listing?.directory).toBe("/work");
  });

  test.each(["success", "failure"] as const)("an in-flight project create %s cannot change a draft or start a session after readiness re-entry", async (outcome) => {
    const f = fixture();
    enterDraft(f);
    const old = deferredProjectResult<{ project: RuntimeProject }>();
    f.client.createProject.mockReturnValueOnce(old.promise);
    const pending = f.controller.create();
    f.setReady(false);
    await f.controller.runtimeAvailabilityChanged();
    f.setReady(true);
    await f.controller.runtimeAvailabilityChanged();
    f.controller.updateDraft("name", "Still editing");
    if (outcome === "success") old.resolve({ project: project("old-create") });
    else old.reject(new Error("old create error"));
    await pending;
    expect(f.controller.snapshot()).toMatchObject({ projects: [], draft: { name: "Still editing", directory: "/work/project", saving: false, error: "" } });
    expect(f.client.createProjectSession).not.toHaveBeenCalled();
    expect(f.openSession).not.toHaveBeenCalled();
  });

  test.each(["success", "failure"] as const)("a pending project session %s cannot navigate or report an old error after readiness loss", async (outcome) => {
    const f = fixture();
    const old = deferredProjectResult<{ sessionId: string; project: RuntimeProject }>();
    f.client.createProjectSession.mockReturnValueOnce(old.promise);
    const pending = f.controller.newConversation("project-one");
    f.setReady(false);
    await f.controller.runtimeAvailabilityChanged();
    f.setReady(true);
    await f.controller.runtimeAvailabilityChanged();
    if (outcome === "success") old.resolve({ sessionId: "old-session", project: project() });
    else old.reject(new Error("old session error"));
    await pending;
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.loadSessions).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.controller.snapshot().busyProjectId).toBe("");
  });

  test("a readiness callback observes environment changes before its DOM change callback without duplicate loads", async () => {
    const f = fixture();
    enterDraft(f);
    const old = deferredProjectResult<{ projects: RuntimeProject[] }>();
    f.client.listProjects.mockReturnValueOnce(old.promise);
    const pending = f.controller.load();
    f.setEnvironment("dev");
    f.setReady(false);
    await f.controller.runtimeAvailabilityChanged();
    await f.controller.environmentChanged();
    expect(f.controller.snapshot().draft).toBeNull();
    expect(f.client.listProjects).toHaveBeenCalledTimes(1);
    f.setReady(true);
    f.client.listProjects.mockResolvedValueOnce({ projects: [project("dev")] });
    await f.controller.runtimeAvailabilityChanged();
    await f.controller.environmentChanged();
    old.reject(new Error("old prod error"));
    await pending;
    expect(f.client.listProjects.mock.calls.map(([environment]) => environment)).toEqual(["prod", "dev"]);
    expect(f.controller.snapshot()).toMatchObject({ projects: [project("dev")], error: "", draft: null });
  });
});
