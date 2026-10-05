import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { configureMacNotificationBundle, assertMacNotificationBundle } from "../../computer-access/companion/notification-macos-bundle.js";
import { renderMacNotificationApplet } from "../../computer-access/companion/notification-macos.js";
import { runNotificationProcess } from "../../computer-access/companion/notification-process.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test.skipIf(process.platform !== "darwin")("real osacompile notification bundle retains its executable and compiler metadata without launching", async () => {
  const artifacts = resolve(".codex/artifacts/macos-qa-20261001");
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "native-notification-bundle-"));
  directories.push(directory);
  const app = join(directory, "ABot.app");
  const script = join(directory, "notification-helper.js");
  await writeFile(script, renderMacNotificationApplet(join(directory, "state")));
  await runNotificationProcess({ file: "/usr/bin/osacompile", args: ["-l", "JavaScript", "-s", "-o", app, script], timeoutMs: 30_000 });
  const plist = join(app, "Contents", "Info.plist");
  const readMetadata = async () => JSON.parse(await runNotificationProcess({ file: "/usr/bin/plutil", args: ["-convert", "json", "-o", "-", plist] }));
  const before = await readMetadata();
  expect(typeof before.CFBundleExecutable).toBe("string");
  await configureMacNotificationBundle(app, runNotificationProcess);
  await assertMacNotificationBundle(app, runNotificationProcess);
  const after = await readMetadata();
  expect(after).toEqual({ ...before, CFBundleIdentifier: "com.abot.notifications", CFBundleName: "ABot", CFBundleDisplayName: "ABot",
    LSUIElement: true, OSAAppletStayOpen: true, OSAAppletShowStartupScreen: false, NSHighResolutionCapable: true });
}, 65_000);
