import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import {
  MAC_NOTIFICATION_STOP_SCRIPT,
  renderMacNotificationApplet,
} from "../../computer-access/companion/notification-macos.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const artifacts = resolve(
    ".codex/artifacts/notification-race-review-20260927",
  );
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "macos-paths-"));
  directories.push(directory);
  const backing = join(directory, "notifications.data-" + randomUUID());
  const logical = join(directory, "notifications");
  await mkdir(join(backing, "pending"), { recursive: true });
  await mkdir(join(backing, "ABot.app"));
  await symlink(basename(backing), logical, "dir");
  await writeFile(
    join(directory, "connection.json"),
    JSON.stringify({ url: "ws://abot.localhost:5199" }),
  );
  return { directory, backing, logical };
}

function cocoaContext(apps: unknown[] = []) {
  const delivered: unknown[] = [];
  const center = {
    deliverNotification: (value: unknown) => delivered.push(value),
    removeDeliveredNotification: vi.fn(),
  };
  const wrap = Object.assign(
    (value: any): any => {
      if (typeof value !== "string") return value;
      return {
        toString: () => value,
        get stringByResolvingSymlinksInPath() {
          try {
            return realpathSync(value);
          } catch {
            return value;
          }
        },
        writeToFileAtomicallyEncodingError: (target: any) => {
          writeFileSync(String(target), value);
          return true;
        },
      };
    },
    {
      NSUserNotificationCenter: { defaultUserNotificationCenter: center },
      NSString: {
        stringWithContentsOfFileEncodingError: (file: any) =>
          wrap(readFileSync(String(file), "utf8")),
      },
      NSUTF8StringEncoding: 4,
      NSUserNotification: { alloc: {} },
      ABotDesktopNotificationDelegate: { alloc: { init: {} } },
      NSRunningApplication: {
        runningApplicationsWithBundleIdentifier: () => ({
          count: apps.length,
          objectAtIndex: (index: number) => apps[index],
        }),
      },
    },
  );
  Object.defineProperty(wrap.NSUserNotification.alloc, "init", {
    get: () => ({}),
  });
  const context: any = {
    $: wrap,
    ObjC: {
      import: () => {},
      unwrap: (value: any) => String(value),
      registerSubclass: () => {},
    },
  };
  return { context, delivered, wrap };
}

function payload() {
  return {
    notificationId: "a".repeat(64),
    title: "Result ready",
    body: "Open the conversation.",
    url: "http://abot.localhost:5199/chat?environment=dev&session=one",
    expiresAt: Date.now() + 10_000,
  };
}

test
  .skipIf(process.platform === "win32")
  .each(["logical", "canonical"] as const)(
  "Mac applet accepts a %s document path and writes the sender's receipt through the owned alias",
  async (form) => {
    const f = await fixture();
    const filename = randomUUID() + ".json";
    const file = join(f.logical, "pending", filename);
    await writeFile(file, JSON.stringify(payload()));
    const { context, delivered } = cocoaContext();
    runInNewContext(renderMacNotificationApplet(f.directory), context);
    context.openDocuments([form === "logical" ? file : realpathSync(file)]);
    expect(delivered).toHaveLength(1);
    expect(JSON.parse(await readFile(file + ".result", "utf8"))).toEqual({
      ok: true,
    });
  },
);

test.skipIf(process.platform === "win32")(
  "Mac applet rejects files in another backing directory and links escaping its pending directory",
  async () => {
    const f = await fixture();
    const foreign = join(f.directory, "notifications.data-foreign", "pending");
    await mkdir(foreign, { recursive: true });
    const file = join(foreign, randomUUID() + ".json");
    await writeFile(file, JSON.stringify(payload()));
    const escaped = join(f.logical, "pending", randomUUID() + ".json");
    await symlink(file, escaped);
    const { context, delivered } = cocoaContext();
    runInNewContext(renderMacNotificationApplet(f.directory), context);
    context.openDocuments([file, escaped]);
    expect(delivered).toEqual([]);
    await expect(access(file + ".result")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

test
  .skipIf(process.platform === "win32")
  .each(["logical", "canonical"] as const)(
  "Mac stop helper matches a %s registered app path to its canonical running bundle only",
  async (form) => {
    const f = await fixture();
    const foreign = join(f.directory, "another", "ABot.app");
    await mkdir(foreign, { recursive: true });
    const logicalApp = join(f.logical, "ABot.app");
    const expected = realpathSync(logicalApp);
    function application(path: string) {
      const app = { bundleURL: { path }, terminated: false };
      Object.defineProperty(app, "terminate", {
        get: () => {
          app.terminated = true;
          return true;
        },
      });
      return app;
    }
    const owned = application(expected);
    const unrelated = application(foreign);
    const { context } = cocoaContext([unrelated, owned]);
    runInNewContext(MAC_NOTIFICATION_STOP_SCRIPT, context);
    context.run([form === "logical" ? logicalApp : expected]);
    expect(owned.terminated).toBe(true);
    expect(unrelated.terminated).toBe(false);
  },
);
