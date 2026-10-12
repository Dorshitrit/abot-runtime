import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  recoverRuntimeSetupEdit,
  requireRuntimeSetupEditSettled,
} from "../../web-ui/local-runtime/runtime-setup-edit-recovery.js";
import { readSetupEditJournal } from "../../web-ui/local-runtime/runtime-setup-edit-journal.js";
import { applyAndCompleteRuntimeSetup } from "../../web-ui/local-runtime/runtime-setup-completion.js";
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

test.each([0, 1, 2, 3, 4, 5])(
  "fresh recovery at actual rename boundary %i preserves the complete old or committed new edit",
  async (boundary) => {
    fixture = await createSetupEditFixture();
    const { before, boundaries, after } = await fixture.capture();
    expect(boundaries).toHaveLength(6);
    await fixture.restoreState(boundaries[boundary].state);
    expect(() => requireRuntimeSetupEditSettled(fixture.rootDir)).toThrow();
    const apply = vi.fn(async () => ({ status: "ready" as const }));
    await expect(
      applyAndCompleteRuntimeSetup(fixture.service() as never, apply),
    ).rejects.toMatchObject({
      code: "setup_edit_recovery_required",
    });
    expect(apply).not.toHaveBeenCalled();
    await recoverRuntimeSetupEdit(fixture.rootDir);
    expect(await fixture.readState()).toEqual(boundary === 5 ? after : before);
    const status = await fixture.service().status();
    expect(status.existingModel).toMatchObject({
      model: boundary === 5 ? "new-model" : "old-model",
      baseUrl:
        boundary === 5 ? "http://127.0.0.1:11436" : "http://127.0.0.1:11435",
    });
    expect(status.editableConnection).toBeDefined();
    await recoverRuntimeSetupEdit(fixture.rootDir);
    expect(await fixture.readState()).toEqual(boundary === 5 ? after : before);
    if (boundary !== 5)
      await expect(fixture.service().save(fixture.next)).resolves.toBeDefined();
  },
);

test("rollback remains idempotent when recovery itself stops after its first replacement", async () => {
  fixture = await createSetupEditFixture({ credentials: true });
  const { before, boundaries } = await fixture.capture();
  await fixture.restoreState(boundaries[4].state);
  const rename = fs.rename;
  let interruptedOnce = false;
  const interrupted = vi
    .spyOn(fs, "rename")
    .mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(to) !== fixture.paths[3] || interruptedOnce) return;
      interruptedOnce = true;
      throw new Error("fixture-recovery-interrupted");
    });
  await expect(recoverRuntimeSetupEdit(fixture.rootDir)).rejects.toThrow(
    "fixture-recovery-interrupted",
  );
  interrupted.mockRestore();
  expect(await readSetupEditJournal(fixture.rootDir)).toBeDefined();
  await recoverRuntimeSetupEdit(fixture.rootDir);
  expect(await fixture.readState()).toEqual(before);
});

test.each([0, 1, 2, 3])(
  "external changes to participant %i prevent every rollback write",
  async (index) => {
    fixture = await createSetupEditFixture({ credentials: true });
    const { boundaries } = await fixture.capture();
    await fixture.restoreState(boundaries[4].state);
    await fs.appendFile(fixture.paths[index], "\nexternal-change");
    const changed = await fixture.readState();
    await expect(
      recoverRuntimeSetupEdit(fixture.rootDir),
    ).rejects.toMatchObject({ code: "setup_edit_recovery_required" });
    expect(await fixture.readState()).toEqual(changed);
  },
);

test("a credential permission change prevents rollback without exposing saved keys", async () => {
  fixture = await createSetupEditFixture({ credentials: true });
  const { boundaries } = await fixture.capture();
  await fixture.restoreState(boundaries[4].state);
  await fs.chmod(fixture.paths[3], 0o400);
  const changed = await fixture.readState();
  await expect(recoverRuntimeSetupEdit(fixture.rootDir)).rejects.toThrow(
    "interrupted connection edit",
  );
  expect(await fixture.readState()).toEqual(changed);
});

test("rollback removes credentials that were absent before the edit", async () => {
  fixture = await createSetupEditFixture({ credentials: true });
  await fs.rm(fixture.paths[3]);
  const { before, boundaries } = await fixture.capture();
  await fixture.restoreState(boundaries[4].state);
  await recoverRuntimeSetupEdit(fixture.rootDir);
  expect(await fixture.readState()).toEqual(before);
  await expect(fs.stat(fixture.paths[3])).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("legitimate absolute config paths outside the root, including spaces, remain recoverable", async () => {
  fixture = await createSetupEditFixture({ customPath: true });
  const { before, boundaries } = await fixture.capture();
  await fixture.restoreState(boundaries[1].state);
  await recoverRuntimeSetupEdit(fixture.rootDir);
  expect(await fixture.readState()).toEqual(before);
  await expect(fixture.service().save(fixture.next)).resolves.toBeDefined();
});

test("no journal does not speculate about mixed legacy configuration or write files", async () => {
  fixture = await createSetupEditFixture();
  const { boundaries } = await fixture.capture();
  const legacy = {
    ...boundaries[1].state,
    [fixture.journalPath]: { bytes: null, mode: 0 },
  };
  await fixture.restoreState(legacy);
  await recoverRuntimeSetupEdit(fixture.rootDir);
  expect(await fixture.readState()).toEqual(legacy);
});

test.each([
  "invalid-json",
  "wrong-version",
  "wrong-model-binding",
  "wrong-env-binding",
  "wrong-receipt",
])(
  "malformed journal %s blocks recovery and preserves all files",
  async (variant) => {
    fixture = await createSetupEditFixture();
    const { boundaries } = await fixture.capture();
    await fixture.restoreState(boundaries[2].state);
    const journal = JSON.parse(await fs.readFile(fixture.journalPath, "utf8"));
    if (variant === "wrong-version") journal.version = 7;
    if (variant === "wrong-model-binding")
      journal.files[0].path = join(fixture.rootDir, "unowned.json");
    if (variant === "wrong-env-binding")
      journal.files[3].path = join(fixture.rootDir, "unowned.env");
    if (variant === "wrong-receipt")
      journal.files[2].after.bytes = Buffer.from("{}").toString("base64");
    await fs.writeFile(
      fixture.journalPath,
      variant === "invalid-json" ? "{" : JSON.stringify(journal) + "\n",
    );
    const changed = await fixture.readState();
    await expect(
      recoverRuntimeSetupEdit(fixture.rootDir),
    ).rejects.toMatchObject({ code: "setup_edit_recovery_required" });
    expect(await fixture.readState()).toEqual(changed);
  },
);

test.skipIf(process.platform === "win32").each(["journal", "model"])(
  "symlinked %s is rejected without touching its target",
  async (target) => {
    fixture = await createSetupEditFixture();
    const { boundaries } = await fixture.capture();
    await fixture.restoreState(boundaries[2].state);
    const path = target === "journal" ? fixture.journalPath : fixture.paths[0];
    const outside = join(fixture.workspace, "external.json");
    const original = await fs.readFile(path);
    await fs.writeFile(outside, original);
    await fs.rm(path);
    await fs.symlink(outside, path);
    await expect(
      recoverRuntimeSetupEdit(fixture.rootDir),
    ).rejects.toMatchObject({ code: "setup_edit_recovery_required" });
    expect(await fs.readFile(outside)).toEqual(original);
  },
);
