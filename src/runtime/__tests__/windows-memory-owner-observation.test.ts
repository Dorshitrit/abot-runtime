import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openLockOwnerFile } from "../../../plugins/memory/source/lock-owner-file.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

test.skipIf(process.platform !== "win32")(
  "a deleted owner is reported missing after closing the Windows observer handle",
  async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const parent = join(process.cwd(),
      ".codex/artifacts/windows-session-steering-20261010/memory-review/owner-observation-fixtures");
    await actual.mkdir(parent, { recursive: true });
    const root = await actual.mkdtemp(join(parent, "case-"));
    roots.push(root);
    const owner = join(root, "owner-synthetic.json");
    await actual.writeFile(owner, "Synthetic owner observation fixture.");
    const opened = gate(), resumed = gate();
    let observedHandle: fs.FileHandle | undefined;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (String(args[0]) === owner) {
        observedHandle = handle;
        opened.release();
        await resumed.ready;
      }
      return handle;
    });
    const observing = openLockOwnerFile(owner);
    void observing.catch(() => undefined);
    try {
      await Promise.race([opened.ready, observing.then(() => {
        throw new Error("Owner observation completed before its handle was held.");
      })]);
      await actual.unlink(owner);
      resumed.release();
      await expect(observing).rejects.toMatchObject({ code: "ENOENT" });
      expect(observedHandle).toBeDefined();
      await expect(observedHandle!.stat()).rejects.toMatchObject({ code: "EBADF" });
      expect(await actual.readdir(root)).toEqual([]);
    } finally {
      resumed.release();
      await Promise.allSettled([observing]);
      await observedHandle?.close();
      vi.mocked(fs.open).mockImplementation(actual.open);
    }
  },
  30_000,
);
