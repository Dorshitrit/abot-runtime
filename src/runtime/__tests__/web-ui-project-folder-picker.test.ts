import { describe, expect, test } from "vitest";
import type { ProjectFolderPage } from "../projects/contracts.js";
import { deferredProjectResult, folderPage, projectsControllerFixture } from "./support/projects-controller-fixture.js";

describe("inline project folder selection", () => {
  test("opens only on Browse and commits the navigated folder only on selection", async () => {
    const f = projectsControllerFixture();
    f.controller.openCreate();
    expect(f.controller.snapshot().draft?.pickerOpen).toBe(false);
    expect(f.client.browseProjectFolders).not.toHaveBeenCalled();
    f.controller.updateDraft("name", "My project");
    f.controller.updateDraft("directory", "/chosen");
    await f.controller.openFolderPicker();
    expect(f.client.browseProjectFolders).toHaveBeenCalledWith("/chosen", "", "prod");
    expect(f.controller.snapshot().draft?.pickerOpen).toBe(true);
    f.client.browseProjectFolders.mockResolvedValueOnce(folderPage("/chosen/child"));
    await f.controller.browse("/chosen/child");
    expect(f.controller.snapshot().draft?.directory).toBe("/chosen");
    await f.controller.create();
    expect(f.client.createProject).not.toHaveBeenCalled();
    f.controller.selectFolder();
    expect(f.controller.snapshot().draft).toMatchObject({
      name: "My project", directory: "/chosen/child", pickerOpen: false,
    });
    await f.controller.create();
    expect(f.client.createProject).toHaveBeenCalledWith(
      { name: "My project", directory: "/chosen/child" }, "prod",
    );
  });

  test("Browse resolves the host default when no path was entered", async () => {
    const f = projectsControllerFixture();
    f.controller.openCreate();
    await f.controller.openFolderPicker();
    expect(f.client.browseProjectFolders).toHaveBeenCalledWith("", "", "prod");
    expect(f.controller.snapshot().draft?.directory).toBe("");
    f.controller.selectFolder();
    expect(f.controller.snapshot().draft?.directory).toBe("/work");
  });

  test("cancelling during loading preserves manual fields and rejects the late response", async () => {
    const f = projectsControllerFixture();
    const pending = deferredProjectResult<ProjectFolderPage>();
    f.client.browseProjectFolders.mockReturnValueOnce(pending.promise);
    f.controller.openCreate();
    f.controller.updateDraft("name", "Preserved");
    f.controller.updateDraft("directory", "/manual");
    const opening = f.controller.openFolderPicker();
    f.controller.selectFolder();
    expect(f.controller.snapshot().draft?.pickerOpen).toBe(true);
    f.controller.cancelFolderPicker();
    pending.resolve(folderPage("/late"));
    await opening;
    expect(f.controller.snapshot().draft).toMatchObject({
      name: "Preserved", directory: "/manual", pickerOpen: false,
      loading: false, listing: null, error: "",
    });
  });

  test("an old response cannot replace the list after cancelling and reopening", async () => {
    const f = projectsControllerFixture();
    const old = deferredProjectResult<ProjectFolderPage>();
    f.client.browseProjectFolders.mockReturnValueOnce(old.promise);
    f.controller.openCreate();
    const opening = f.controller.openFolderPicker();
    f.controller.cancelFolderPicker();
    f.client.browseProjectFolders.mockResolvedValueOnce(folderPage("/new"));
    await f.controller.openFolderPicker();
    old.resolve(folderPage("/old"));
    await opening;
    expect(f.controller.snapshot().draft?.listing?.directory).toBe("/new");
    expect(f.controller.snapshot().draft?.pickerOpen).toBe(true);
  });

  test("failed navigation cannot select a stale earlier folder", async () => {
    const f = projectsControllerFixture();
    f.controller.openCreate();
    f.controller.updateDraft("directory", "/manual");
    await f.controller.openFolderPicker();
    f.client.browseProjectFolders.mockRejectedValueOnce(new Error("Folder is unavailable"));
    await f.controller.browse("/missing");
    f.controller.selectFolder();
    expect(f.controller.snapshot().draft).toMatchObject({
      directory: "/manual", pickerOpen: true, loading: false,
      listing: null, error: "Folder is unavailable",
    });
    f.controller.cancelFolderPicker();
    expect(f.controller.snapshot().draft?.error).toBe("");
  });

  test("pagination appends folders without committing the browsed path", async () => {
    const f = projectsControllerFixture();
    f.controller.openCreate();
    f.client.browseProjectFolders.mockResolvedValueOnce({
      ...folderPage("/work"), entries: [{ name: "one", path: "/work/one" }], nextCursor: "next",
    });
    await f.controller.openFolderPicker();
    f.client.browseProjectFolders.mockResolvedValueOnce({
      ...folderPage("/work"), entries: [{ name: "two", path: "/work/two" }],
    });
    await f.controller.browse("/work", "next");
    expect(f.controller.snapshot().draft?.listing?.entries.map(({ name }) => name)).toEqual(["one", "two"]);
    expect(f.controller.snapshot().draft?.directory).toBe("");
  });
});
