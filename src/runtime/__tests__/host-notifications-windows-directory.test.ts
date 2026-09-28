import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { publishWindowsNotificationDirectory } from "../../computer-access/companion/notification-directory-windows.js";
import {
  runNotificationProcess,
  type NotificationProcessRunner,
} from "../../computer-access/companion/notification-process.js";

test("Windows publication passes Unicode and shell metacharacters as data and propagates failure", async () => {
  const source = String.raw`C:\ABot בדיקה\$(whoami); 'staged'`;
  const destination = String.raw`C:\ABot בדיקה\notifications`;
  const run = vi.fn<NotificationProcessRunner>(async () => "");
  await publishWindowsNotificationDirectory(source, destination, run);
  const request = run.mock.calls[0]![0];
  expect(JSON.parse(request.input!)).toEqual({ source, destination });
  const encoded = request.args.at(-1)!;
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  expect(script).not.toContain(source);
  expect(script).not.toContain(destination);
  const failure = new Error("destination exists");
  run.mockRejectedValueOnce(failure);
  await expect(
    publishWindowsNotificationDirectory(source, destination, run),
  ).rejects.toBe(failure);
});

test.runIf(process.platform === "win32")(
  "Windows publication preserves raced destinations and publishes complete ownership when absent",
  async () => {
    const artifacts = resolve(".codex/artifacts/notification-directory-tests");
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(join(artifacts, "windows-"));
    try {
      for (const kind of ["absent", "directory", "file"] as const) {
        const folder = join(root, kind);
        const source = join(folder, "staged");
        const destination = join(folder, "notifications");
        await mkdir(source, { recursive: true });
        await writeFile(join(source, ".owner"), "complete owner");
        if (kind === "directory") await mkdir(destination);
        if (kind === "file") await writeFile(destination, "preserve");
        if (kind === "absent") {
          await publishWindowsNotificationDirectory(
            source,
            destination,
            runNotificationProcess,
          );
          expect(await readFile(join(destination, ".owner"), "utf8")).toBe(
            "complete owner",
          );
          await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
          continue;
        }
        const before = await lstat(destination);
        await expect(
          publishWindowsNotificationDirectory(
            source,
            destination,
            runNotificationProcess,
          ),
        ).rejects.toThrow();
        const after = await lstat(destination);
        expect(after.ino).toBe(before.ino);
        expect(after.isDirectory()).toBe(before.isDirectory());
        expect(await readdir(source)).toEqual([".owner"]);
        if (kind === "file")
          expect(await readFile(destination, "utf8")).toBe("preserve");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
