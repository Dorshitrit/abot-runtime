import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createConfigWorkspaceModel } from "../../web-ui/app/components/config-workspace/config-model.js";
// @ts-expect-error Browser-only module.
import { createConfigWorkspaceMutations } from "../../web-ui/app/components/config-workspace/workspace-mutations.js";
// @ts-expect-error Browser-only module.
import { createConfigWorkspacePersistence } from "../../web-ui/app/components/config-workspace/workspace-persistence.js";
// @ts-expect-error Browser-only module.
import { createConfigDashboardRendering } from "../../web-ui/app/components/config-workspace/dashboard-rendering.js";

function malformedFile(kind = "requestRunner", id = "runner") {
  return {
    kind, id, label: id, path: `/fixture/${id}.json`, exists: true,
    config: {}, revision: `${id}-revision`,
    invalidJson: { raw: `{ "${id}": `, message: "Invalid JSON in linked file." },
  };
}

function harness(files = [malformedFile()]) {
  const model = createConfigWorkspaceModel();
  const editor = { value: "" };
  const status = { textContent: "" };
  const dom = { configDashboard: { querySelector: () => editor }, configStatus: status };
  const confirmDiscard = vi.fn(() => true);
  const saveFile = vi.fn(async (input: Record<string, unknown>) => ({
    file: { ...input, revision: "saved-revision" },
  }));
  const rendering = createConfigDashboardRendering({
    ...model, fileStatusText: () => "status",
  });
  const render = vi.fn(() => {
    const file = model.selectedRawConfigFile();
    if (file) editor.value = model.rawDraftFor(file);
  });
  const mutations = createConfigWorkspaceMutations({
    ...model, dom, confirmDiscard, recordControlEvent: vi.fn(),
    renderConfigDashboard: render,
    setWorkspaceStatus: (message: string) => { status.textContent = message; },
    syncDirtyPresentation: vi.fn(),
  });
  const persistence = createConfigWorkspacePersistence({
    ...model, ...mutations, dom, saveFile,
    syncDashboardInteractivity: vi.fn(), syncDirtyPresentation: vi.fn(),
    recordControlEvent: vi.fn(),
    setWorkspaceStatus: (message: string) => { status.textContent = message; },
  });
  mutations.replaceDashboard({ dashboard: { files: {
    runtime: { kind: "runtime", id: "runtime", label: "Runtime", config: {}, revision: "root" },
    requestRunner: files.find((file) => file.kind === "requestRunner"),
    models: files.filter((file) => file.kind === "model"),
  } } });
  function draft(raw: string) {
    editor.value = raw;
    model.state.rawDraftsByKey.set(model.state.selectedRawConfigKey, raw);
  }
  return { model, mutations, persistence, rendering, editor, status, saveFile, confirmDiscard, draft };
}

test("malformed linked files open Advanced Raw JSON with their exact clean baseline", () => {
  const file = malformedFile();
  const h = harness([file]);
  expect(h.model.state.activeCategory).toBe("advanced");
  expect(h.model.state.rawPanelOpen).toBe(true);
  expect(h.model.selectedRawConfigFile()).toBe(file);
  expect(h.editor.value).toBe(file.invalidJson.raw);
  expect(h.model.hasUnsavedChanges()).toBe(false);
  expect(h.mutations.confirmDiscardChanges()).toBe(true);
  expect(h.confirmDiscard).not.toHaveBeenCalled();
  const markup = h.rendering.renderConfigMap();
  expect(markup).toContain("Correct the JSON");
  expect(markup).toContain("&quot;runner&quot;");
});

test("an empty object repair stays dirty after Apply draft and saves with the original revision", async () => {
  const file = malformedFile();
  const h = harness([file]);
  h.draft("{}");
  expect(h.model.hasRawDraftChanges(file)).toBe(true);
  expect(h.mutations.applyRawDraft()).toBe(file);
  expect(h.model.isFileDirty(file)).toBe(true);
  expect(h.model.hasRawDraftChanges(file)).toBe(false);
  expect(file.invalidJson.raw).toBe('{ "runner": ');
  await expect(h.persistence.saveConfigFile(file.kind, file.id)).resolves.toBe(true);
  expect(h.saveFile).toHaveBeenCalledWith({ kind: file.kind, id: file.id, config: {}, expectedRevision: "runner-revision" });
  expect(file).not.toHaveProperty("invalidJson");
  expect(file.revision).toBe("saved-revision");
  expect(h.model.hasUnsavedChanges()).toBe(false);
  expect(h.rendering.renderConfigMap()).not.toContain("Correct the JSON");
});

test("reset and confirmed discard restore malformed raw bytes after a parsed repair", () => {
  const file = malformedFile();
  const h = harness([file]);
  h.draft('{ "fixed": true }');
  h.mutations.applyRawDraft();
  h.mutations.resetConfigFile(file.kind, file.id);
  expect(h.editor.value).toBe(file.invalidJson.raw);
  expect(file.config).toEqual({});
  expect(h.model.hasUnsavedChanges()).toBe(false);
  h.draft("{}");
  h.mutations.applyRawDraft();
  expect(h.mutations.confirmDiscardChanges("close")).toBe(true);
  expect(h.confirmDiscard).toHaveBeenCalledOnce();
  expect(h.editor.value).toBe(file.invalidJson.raw);
  expect(h.model.hasUnsavedChanges()).toBe(false);
});

test("a conflict preserves the parsed repair, original raw receipt and expected revision", async () => {
  const file = malformedFile();
  const h = harness([file]);
  const conflict = new Error("Configuration changed");
  h.saveFile.mockRejectedValueOnce(conflict);
  h.draft("{}");
  h.mutations.applyRawDraft();
  await expect(h.persistence.saveConfigFile(file.kind, file.id)).rejects.toBe(conflict);
  expect(file.invalidJson.raw).toBe('{ "runner": ');
  expect(file.revision).toBe("runner-revision");
  expect(h.editor.value).toBe("{}");
  expect(h.model.isFileDirty(file)).toBe(true);
  expect(h.model.state.savedKeys.size).toBe(0);
});

test("an untouched malformed sibling stays clean and does not block repairing another file", async () => {
  const runner = malformedFile();
  const model = malformedFile("model", "broken-model");
  const h = harness([runner, model]);
  h.draft("{}");
  h.mutations.applyRawDraft();
  expect(h.model.dirtyFiles()).toEqual([runner]);
  await h.persistence.saveConfigFile(runner.kind, runner.id);
  expect(h.model.dirtyFiles()).toEqual([]);
  expect(model.invalidJson.raw).toBe('{ "broken-model": ');
  h.mutations.changeRawFile("model:broken-model", { value: "" });
  expect(h.model.rawDraftFor(model)).toBe(model.invalidJson.raw);
  expect(h.confirmDiscard).not.toHaveBeenCalled();
});

test("invalid JSON stays a draft and cannot be applied or saved", async () => {
  const file = malformedFile();
  const h = harness([file]);
  h.draft("still broken");
  await h.persistence.saveRawDraft();
  expect(h.saveFile).not.toHaveBeenCalled();
  expect(h.model.isFileDirty(file)).toBe(false);
  expect(h.model.hasRawDraftChanges(file)).toBe(true);
  expect(h.status.textContent).toContain("Raw JSON:");
  expect(file.invalidJson.raw).toBe('{ "runner": ');
});

test("structured edits cannot replace the malformed placeholder before raw repair", () => {
  const file = malformedFile("model", "broken-model");
  const h = harness([file]);
  const edit = vi.fn((config: Record<string, unknown>) => { config.model = "changed"; });
  h.mutations.mutateConfigFile(file.kind, file.id, edit);
  expect(edit).not.toHaveBeenCalled();
  expect(h.status.textContent).toContain("Raw JSON");
  expect(h.editor.value).toBe(file.invalidJson.raw);
  h.draft("{}");
  h.mutations.applyRawDraft();
  h.mutations.mutateConfigFile(file.kind, file.id, edit);
  expect(edit).toHaveBeenCalledOnce();
  expect(file.config).toEqual({ model: "changed" });
  expect(h.model.isFileDirty(file)).toBe(true);
});

test("changing raw selection can discard an unapplied repair back to its original baseline", () => {
  const runner = malformedFile();
  const model = malformedFile("model", "broken-model");
  const h = harness([runner, model]);
  h.draft("unfinished repair");
  h.mutations.changeRawFile("model:broken-model", { value: "" });
  expect(h.confirmDiscard).toHaveBeenCalledOnce();
  expect(h.model.rawDraftFor(runner)).toBe(runner.invalidJson.raw);
  expect(h.model.hasUnsavedChanges()).toBe(false);
});

test("repair metadata survives an in-flight save and clears only after success", async () => {
  const file = malformedFile();
  const h = harness([file]);
  let complete!: (value: { file: { revision: string } }) => void;
  h.saveFile.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  h.draft("{}");
  h.mutations.applyRawDraft();
  const saving = h.persistence.saveConfigFile(file.kind, file.id);
  expect(file.invalidJson.raw).toBe('{ "runner": ');
  expect(h.model.isFileDirty(file)).toBe(true);
  complete({ file: { revision: "confirmed-revision" } });
  await saving;
  expect(file).not.toHaveProperty("invalidJson");
  expect(h.model.hasUnsavedChanges()).toBe(false);
});
