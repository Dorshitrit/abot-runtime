import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);

test.skipIf(process.platform === "win32")("bounded regular-file reads reject an unopened FIFO without waiting for a writer", async () => {
  const artifacts = resolve(".codex/artifacts/project-git-diff-20261028");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "sdk-fifo-"));
  try {
    const fifo = join(root, "replacement");
    await execute("mkfifo", [fifo]);
    const moduleUrl = pathToFileURL(resolve("src/plugin-sdk/files.ts")).href;
    const probe = `import { readBoundedRegularFile } from ${JSON.stringify(moduleUrl)};
      const result = await readBoundedRegularFile(process.argv[1], { rootPath: process.argv[2], maxBytes: 4096 });
      process.stdout.write(JSON.stringify(result));`;
    // Isolate the syscall so a regression cannot strand the test worker.
    const result = await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe, fifo, root], {
      timeout: 5000, killSignal: "SIGKILL",
    });
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, reason: "not_regular_file" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
