import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createLearningStateStore } from "../passive-learning/store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function stateStore() {
  const directory = await mkdtemp(join(tmpdir(), "learning-initial-preferences-"));
  directories.push(directory);
  return { directory, store: createLearningStateStore(directory) };
}

test("new installations initialize every activity off", async () => {
  const { store } = await stateStore();
  const state = await store.read();
  expect(state.preferences).toMatchObject({
    enabled: false, processingPaused: true, proactiveEnabled: false,
  });
  expect(state.preferences.modelProfileId).toBeUndefined();
  expect(state.batches).toEqual([]);
});

test.each([true, false])("preserves saved processingPaused=%s independently of collection", async (processingPaused) => {
  const { store } = await stateStore();
  const state = await store.read();
  await store.write({ ...state, preferences: {
    ...state.preferences, enabled: false, processingPaused, modelProfileId: "saved-model",
  } });
  expect((await store.read()).preferences).toMatchObject({
    enabled: false, processingPaused, modelProfileId: "saved-model",
  });
});

test.each([true, false])("preserves legacy enabled=%s processing behavior", async (enabled) => {
  const { directory, store } = await stateStore();
  await writeFile(join(directory, "state.json"), JSON.stringify({
    schemaVersion: 1,
    preferences: { enabled, modelProfileId: "legacy-model", excludedApplications: [] },
    batches: [],
  }));
  expect((await store.read()).preferences).toMatchObject({
    enabled, processingPaused: !enabled, modelProfileId: "legacy-model",
  });
});
