import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveSearchRoot } from "../../../plugins/local-search/source/paths.js";
import { spawnWindowsSearch } from "../../../plugins/local-search/source/windows-search-process.js";
import type { WindowsSearchAuthority } from "../../../plugins/local-search/source/windows-authority.js";
import { runRipgrepPathSearch } from "../../../plugins/local-search/source/ripgrep.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

const active: ReturnType<typeof spawnWindowsSearch>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const invocation of active.splice(0)) {
    if (
      invocation.child.exitCode !== null ||
      invocation.child.signalCode !== null
    )
      continue;
    const closed = new Promise<void>((resolve) =>
      invocation.child.once("close", () => resolve()),
    );
    invocation.terminate();
    await closed;
  }
  await removePortablePluginFixtures();
});

async function fixture(isFile = false) {
  const context = await createPortablePluginFixture("local-search");
  const root = context.runtimePaths.agentWorkDir;
  await mkdir(join(root, "parent", "selected"), { recursive: true });
  if (isFile)
    await writeFile(join(root, "parent", "selected", "file.txt"), "needle");
  const path = isFile ? "parent/selected/file.txt" : "parent/selected";
  const selection = await resolveSearchRoot(context, path);
  return {
    root,
    context,
    selection,
    authority: selection.directoryAuthority as WindowsSearchAuthority,
  };
}

function start(authority: WindowsSearchAuthority, program: string) {
  const invocation = spawnWindowsSearch({
    authority,
    command: process.execPath,
    args: ["-e", program],
    env: process.env,
  });
  active.push(invocation);
  const closed = new Promise<number | null>((resolve) =>
    invocation.child.once("close", resolve),
  );
  let output = "";
  let notify!: (text: string) => void;
  let fail!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    notify = resolve;
    fail = reject;
  });
  invocation.child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.includes("\n")) notify(output.trim());
  });
  invocation.child.stderr.resume();
  invocation.child.once("error", fail);
  void closed.then((code) => {
    if (!output.includes("\n"))
      fail(new Error("Search helper closed before ready: " + code));
  });
  // Tests expecting startup failure use closed; consume ready's rejection as well.
  void ready.catch(() => undefined);
  return { ...invocation, ready, closed, output: () => output };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe.skipIf(process.platform !== "win32")(
  "Windows local search authority",
  () => {
    test.each([false, true])(
      "pins the selected path and ancestors until shutdown (file=%s)",
      async (isFile) => {
        const { root, selection, authority } = await fixture(isFile);
        try {
          const invocation = start(
            authority,
            'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)',
          );
          await invocation.ready;
          for (const path of [
            join(root, "parent"),
            join(root, "parent", "selected"),
            authority.targetPath,
          ]) {
            await expect(rename(path, path + "-moved")).rejects.toMatchObject({
              code: expect.stringMatching(/^(EPERM|EACCES|EBUSY)$/),
            });
          }
          invocation.terminate();
          await invocation.closed;
          await selection.close();
          await rename(join(root, "parent"), join(root, "parent-moved"));
        } finally {
          await selection.close();
        }
      },
      20_000,
    );

    test("rejects a replaced selection before starting the command", async () => {
      const { selection, authority } = await fixture();
      try {
        await rename(authority.targetPath, authority.targetPath + "-old");
        await mkdir(authority.targetPath);
        const invocation = start(
          authority,
          'process.stdout.write("UNAUTHORIZED\\n")',
        );
        expect(await invocation.closed).toBe(125);
        expect(invocation.output()).toBe("");
      } finally {
        await selection.close();
      }
    }, 20_000);

    test("job shutdown also stops descendants of the command", async () => {
      const { selection, authority } = await fixture();
      try {
        const childProgram =
          'process.stdout.write(String(process.pid) + "\\n"); setInterval(() => {}, 1000)';
        const parentProgram =
          'require("node:child_process").spawn(process.execPath, ["-e", ' +
          JSON.stringify(childProgram) +
          '], { stdio: "inherit", detached: true }); setInterval(() => {}, 1000)';
        const invocation = start(authority, parentProgram);
        const pid = Number(await invocation.ready);
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect(isProcessAlive(pid)).toBe(true);
        invocation.terminate();
        await invocation.closed;
        await vi.waitFor(() => expect(isProcessAlive(pid)).toBe(false), {
          timeout: 3_000,
        });
      } finally {
        await selection.close();
      }
    }, 20_000);

    test("an unavailable helper fails explicitly instead of producing empty search results", async () => {
      const { context, selection, authority } = await fixture();
      try {
        vi.stubEnv("SystemRoot", join(context.rootDir, "no-windows-helper"));
        await expect(
          runRipgrepPathSearch(
            ["--files", "."],
            authority.targetPath,
            5,
            undefined,
            authority,
          ),
        ).rejects.toMatchObject({ code: "local_search_windows_unavailable" });
      } finally {
        await selection.close();
      }
    });
  },
);
