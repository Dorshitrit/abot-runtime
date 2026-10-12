import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { RuntimePluginLoadContext } from "../../plugin-sdk/index.js";

const storage = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  verify: vi.fn(async () => undefined),
}));
vi.mock("../../../plugins/system/source/local-command-output-retention.js", () => ({
  scheduleLocalSystemOutputCleanup: storage.initialize,
}));
vi.mock("../../../plugins/system/source/security/windows-output-directory.js", () => ({
  ensureWindowsOutputDirectory: storage.verify,
}));
import { createLocalSystemCommandOutput } from "../../../plugins/system/source/local-command-output.js";

test("first dispatch waits for startup storage work, then performs its own verification", async () => {
  const parent = join(process.cwd(), ".codex/artifacts/windows-public-plugins/system-initialization");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-"));
  let release!: () => void;
  storage.initialize.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const output = createLocalSystemCommandOutput({ stateDir: root, config: {} } as RuntimePluginLoadContext)();
  const marker = join(root, "dispatches");
  const pending = output.run({ executable: process.execPath,
    args: ["-e", "require('node:fs').appendFileSync(process.argv[1], '1')", marker] });
  try {
    await Promise.resolve();
    expect(storage.verify).not.toHaveBeenCalled();
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    release();
    expect(await pending).toMatchObject({ status: "completed", exitCode: 0 });
    expect(storage.verify).toHaveBeenCalledExactlyOnceWith(join(root, "command-output"));
    expect(await readFile(marker, "utf8")).toBe("1");
  } finally {
    release(); await pending;
    await rm(root, { recursive: true, force: true });
  }
});
