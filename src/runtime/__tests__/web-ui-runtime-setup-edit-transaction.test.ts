import * as fs from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as editFiles from "../../web-ui/local-runtime/runtime-setup-edit-files.js";
import { recoverRuntimeSetupEdit } from "../../web-ui/local-runtime/runtime-setup-edit-recovery.js";
import { readSetupEditJournal } from "../../web-ui/local-runtime/runtime-setup-edit-journal.js";
import {
  createSetupEditFixture,
  type SetupEditFixture,
} from "./support/setup-edit-transaction-fixture.js";

vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  )),
}));

let fixture: SetupEditFixture;
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (fixture) await fs.rm(fixture.workspace, { recursive: true, force: true });
});

test("caught credential failure rolls back all four files and retains the old effective key", async () => {
  fixture = await createSetupEditFixture({ credentials: true });
  const before = await fixture.readState();
  const rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === fixture.paths[3])
      throw new Error("fixture-credential-write-failed");
    return rename(from, to);
  });
  await expect(fixture.service().save(fixture.next)).rejects.toThrow(
    "fixture-credential-write-failed",
  );
  expect(await fixture.readState()).toEqual(before);
  expect(process.env.OPENAI_API_KEY).toBe("fixture-old-key");
});

test("committed marker cleanup failure keeps new files and publishes the new effective key", async () => {
  fixture = await createSetupEditFixture({ credentials: true });
  const rm = fs.rm;
  const failure = vi
    .spyOn(fs, "rm")
    .mockImplementation(async (path, options) => {
      if (String(path) === fixture.journalPath)
        throw new Error("fixture-marker-cleanup");
      return rm(path, options);
    });
  await expect(fixture.service().save(fixture.next)).rejects.toThrow(
    "fixture-marker-cleanup",
  );
  expect((await readSetupEditJournal(fixture.rootDir))?.phase).toBe(
    "committed",
  );
  expect(process.env.OPENAI_API_KEY).toBe("fixture-new-key");
  expect(JSON.parse(await fs.readFile(fixture.paths[0], "utf8")).model).toBe(
    "new-model",
  );
  failure.mockRestore();
  await recoverRuntimeSetupEdit(fixture.rootDir);
  expect((await fixture.service().status()).existingModel?.model).toBe(
    "new-model",
  );
});

test("cleanup sync failure after marker unlink cannot leave old process credentials with new files", async () => {
  fixture = await createSetupEditFixture({ credentials: true });
  const sync = editFiles.syncSetupEditDirectory;
  vi.spyOn(editFiles, "syncSetupEditDirectory").mockImplementation(
    async (path) => {
      if (path === fixture.rootDir)
        throw new Error("fixture-final-cleanup-sync");
      return sync(path);
    },
  );
  await expect(fixture.service().save(fixture.next)).rejects.toThrow(
    "fixture-final-cleanup-sync",
  );
  expect(await readSetupEditJournal(fixture.rootDir)).toBeUndefined();
  expect(process.env.OPENAI_API_KEY).toBe("fixture-new-key");
  expect((await fixture.service().status()).existingModel?.model).toBe(
    "new-model",
  );
});

test("failure after publishing the committed marker cannot roll back the transaction", async () => {
  fixture = await createSetupEditFixture({ credentials: true });
  const publish = editFiles.publishSetupEditJournal;
  vi.spyOn(editFiles, "publishSetupEditJournal").mockImplementation(
    async (path, text, before) => {
      await publish(path, text, before);
      if (JSON.parse(text).phase === "committed")
        throw new Error("fixture-marker-post-rename");
    },
  );
  await expect(fixture.service().save(fixture.next)).resolves.toBeDefined();
  expect(process.env.OPENAI_API_KEY).toBe("fixture-new-key");
  expect((await fixture.service().status()).existingModel?.model).toBe(
    "new-model",
  );
});

test("external edit after commit is preserved when cleanup was interrupted", async () => {
  fixture = await createSetupEditFixture({ credentials: true });
  const { boundaries } = await fixture.capture();
  await fixture.restoreState(boundaries[5].state);
  await fs.appendFile(fixture.paths[3], "\nPRESERVED_EXTERNAL_SETTING=value\n");
  const changed = await fixture.readState();
  await expect(recoverRuntimeSetupEdit(fixture.rootDir)).rejects.toMatchObject({
    code: "setup_edit_recovery_required",
  });
  expect(await fixture.readState()).toEqual(changed);
});

test("temporary credential snapshots are removed even when temporary file sync fails", async () => {
  fixture = await createSetupEditFixture({ credentials: true });
  const path = fixture.paths[3];
  const before = await editFiles.readSetupEditFile(path);
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".setup-edit.tmp"))
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          new Error("fixture-temp-sync"),
        );
      return handle;
    },
  );
  await expect(
    editFiles.restoreSetupEditFile(
      path,
      before,
      editFiles.setupEditTextSnapshot("dummy", 0o600),
    ),
  ).rejects.toThrow("fixture-temp-sync");
  expect(await editFiles.readSetupEditFile(path)).toEqual(before);
  expect(
    (await fs.readdir(fixture.rootDir)).filter((name) =>
      name.endsWith(".setup-edit.tmp"),
    ),
  ).toEqual([]);
});
