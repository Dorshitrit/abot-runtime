import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createConfigWorkspacePersistence } from "../../web-ui/app/components/config-workspace/workspace-persistence.js";

function harness(saveFile: ReturnType<typeof vi.fn>) {
  const file = {
    kind: "requestRunner",
    id: "runner",
    config: { value: "draft" },
    revision: "loaded-revision",
  };
  const state = {
    savingKeys: new Set(),
    baselinesByKey: new Map([["runner", { value: "original" }]]),
    savedKeys: new Set(),
    canonicalRefreshInFlight: false,
  };
  const persistence = createConfigWorkspacePersistence({
    state,
    dom: {},
    saveFile,
    findConfigFile: () => file,
    isFileDirty: () => true,
    configFileKey: () => "runner",
    hasRawDraftChanges: () => true,
    baselineFor: () => state.baselinesByKey.get("runner"),
    syncDashboardInteractivity: vi.fn(),
    syncDirtyPresentation: vi.fn(),
    recordControlEvent: vi.fn(),
  });
  return { file, state, persistence };
}

test("passes the loaded revision and advances it only after a confirmed save", async () => {
  const save = vi.fn(async (_input: Record<string, unknown>) => ({
    file: { revision: "saved-revision" },
  }));
  const { persistence, file, state } = harness(save);
  await persistence.saveConfigFile("requestRunner", "runner");
  expect(save).toHaveBeenCalledWith({
    kind: "requestRunner",
    id: "runner",
    config: { value: "draft" },
    expectedRevision: "loaded-revision",
  });
  expect(file.revision).toBe("saved-revision");
  expect(state.baselinesByKey.get("runner")).toEqual({ value: "draft" });
  file.config.value = "second draft";
  await persistence.saveConfigFile("requestRunner", "runner");
  expect(save.mock.calls[1]?.[0]).toMatchObject({
    expectedRevision: "saved-revision",
  });
});

test("a revision conflict preserves both the user's draft and original baseline for recovery", async () => {
  const conflict = Object.assign(
    new Error("Refresh Configuration before saving again."),
    { status: 409 },
  );
  const save = vi.fn(async () => {
    throw conflict;
  });
  const { persistence, file, state } = harness(save);
  await expect(
    persistence.saveConfigFile("requestRunner", "runner"),
  ).rejects.toBe(conflict);
  expect(file.config).toEqual({ value: "draft" });
  expect(file.revision).toBe("loaded-revision");
  expect(state.baselinesByKey.get("runner")).toEqual({ value: "original" });
  expect(state.savedKeys.size).toBe(0);
  expect(state.savingKeys.size).toBe(0);
});
