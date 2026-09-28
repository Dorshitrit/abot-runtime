import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  installLocalMacCompanion,
  LocalCompanionSetupError,
  type LocalCompanionInstallationDependencies,
} from "../../computer-access/companion/local-installation.js";

const bundle = Buffer.from("// trusted bundled companion\n");
const request = {
  bundle,
  url: "http://abot.localhost:5177",
  code: "a".repeat(43),
};
const digest = createHash("sha256").update(bundle).digest("hex");
let homeDir: string;
let installDir: string;
let bundlePath: string;

type FakeSetupChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function fakeSetupProcess(
  complete: (child: FakeSetupChild) => void = (child) => child.emit("close", 0),
) {
  const child = new EventEmitter() as FakeSetupChild;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    }),
  });
  let input = "";
  child.stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8");
  });
  child.stdin.on("finish", () => queueMicrotask(() => complete(child)));
  const launch = vi.fn(() => child);
  return {
    child,
    launch,
    input: () => input,
    dependencies: {
      platform: "darwin",
      homeDir,
      spawn: launch as unknown as typeof spawn,
    } satisfies LocalCompanionInstallationDependencies,
  };
}

async function prepareCache(): Promise<void> {
  await mkdir(installDir, { recursive: true, mode: 0o700 });
}

beforeEach(async () => {
  const scratch = resolve(".codex/artifacts/macos-local-connect-20260928");
  await mkdir(scratch, { recursive: true });
  homeDir = await mkdtemp(join(scratch, "local-installation-test-"));
  installDir = join(
    homeDir,
    "Library",
    "Application Support",
    "ABot",
    "HostCompanion",
  );
  bundlePath = join(installDir, "companion-" + digest + ".mjs");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(homeDir, { recursive: true, force: true });
});

test("installs private immutable bundled bytes and reuses the current Node with stdin-only secrets", async () => {
  const fixture = fakeSetupProcess();
  const upgradeHostId = "36664315-57c4-4ad7-a873-93dcc0bff54d";
  await installLocalMacCompanion(
    {
      ...request,
      upgradeHostId,
      nodePath: "/untrusted/node",
      bundlePath: "/untrusted/file",
    } as typeof request,
    fixture.dependencies,
  );
  expect(await readFile(bundlePath)).toEqual(bundle);
  expect((await lstat(bundlePath)).mode & 0o777).toBe(0o600);
  expect((await lstat(installDir)).mode & 0o777).toBe(0o700);
  expect(fixture.launch).toHaveBeenCalledWith(
    process.execPath,
    [bundlePath, "setup"],
    {
      cwd: homeDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    },
  );
  expect(JSON.parse(fixture.input())).toEqual({
    url: request.url,
    code: request.code,
    upgradeHostId,
  });
  expect(JSON.stringify(fixture.launch.mock.calls)).not.toContain(request.code);
  const before = await lstat(bundlePath);
  await installLocalMacCompanion(request, fakeSetupProcess().dependencies);
  const after = await lstat(bundlePath);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
});

test.each(["linux", "win32"] as const)(
  "refuses %s without filesystem mutation or a child",
  async (platform) => {
    const fixture = fakeSetupProcess();
    const missingHome = join(homeDir, "must-not-be-created");
    await expect(
      installLocalMacCompanion(request, {
        ...fixture.dependencies,
        homeDir: missingHome,
        platform,
      }),
    ).rejects.toMatchObject({ code: "host_local_setup_unavailable" });
    expect(fixture.launch).not.toHaveBeenCalled();
    await expect(lstat(missingHome)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("the production platform guard rejects the actual non-Mac host", async () => {
  if (process.platform === "darwin") return;
  const fixture = fakeSetupProcess();
  await expect(
    installLocalMacCompanion(request, {
      homeDir,
      spawn: fixture.dependencies.spawn,
    }),
  ).rejects.toMatchObject({ code: "host_local_setup_unavailable" });
  await expect(lstat(installDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  "symlink",
  "directory",
  "checksum",
  "permissions",
  "hardlink",
] as const)("refuses a hostile cached bundle: %s", async (kind) => {
  await prepareCache();
  const outside = join(homeDir, "outside.mjs");
  await writeFile(outside, bundle, { mode: 0o600 });
  if (kind === "symlink") await symlink(outside, bundlePath);
  if (kind === "directory") await mkdir(bundlePath);
  if (kind === "checksum")
    await writeFile(bundlePath, Buffer.alloc(bundle.length), { mode: 0o600 });
  if (kind === "permissions")
    await writeFile(bundlePath, bundle, { mode: 0o644 });
  if (kind === "hardlink") await link(outside, bundlePath);
  const fixture = fakeSetupProcess();
  await expect(
    installLocalMacCompanion(request, fixture.dependencies),
  ).rejects.toMatchObject({ code: "host_local_setup_unsafe_cache" });
  expect(fixture.launch).not.toHaveBeenCalled();
  expect(await readFile(outside)).toEqual(bundle);
});

test.each([
  "directory-link",
  "ancestor-link",
  "public-directory",
  "writable-ancestor",
] as const)("refuses an unsafe installation directory: %s", async (kind) => {
  const outside = join(homeDir, "outside");
  await mkdir(outside, { mode: 0o700 });
  await prepareCache();
  if (kind === "directory-link") {
    await rm(installDir, { recursive: true });
    await symlink(outside, installDir);
  }
  if (kind === "ancestor-link") {
    const ancestor = join(homeDir, "Library");
    await rm(ancestor, { recursive: true });
    await symlink(outside, ancestor);
  }
  if (kind === "public-directory") await chmod(installDir, 0o755);
  if (kind === "writable-ancestor")
    await chmod(join(homeDir, "Library"), 0o777);
  const fixture = fakeSetupProcess();
  await expect(
    installLocalMacCompanion(request, fixture.dependencies),
  ).rejects.toMatchObject({ code: "host_local_setup_unsafe_cache" });
  expect(fixture.launch).not.toHaveBeenCalled();
  await expect(
    lstat(join(outside, "Application Support")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("refuses installation ancestry owned by a different user", async () => {
  const fixture = fakeSetupProcess();
  const uid = process.getuid!();
  vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
  await expect(
    installLocalMacCompanion(request, fixture.dependencies),
  ).rejects.toMatchObject({ code: "host_local_setup_unsafe_cache" });
  expect(fixture.launch).not.toHaveBeenCalled();
});

test.each([
  "A Runtime is already paired. Use 'abot host disconnect' before pairing another.",
  "The paired computer connection is missing. Reconnect from ABot Settings.",
  "This upgrade belongs to a different paired computer connection.",
  "Pairing did not complete. Check ABot Settings and use a fresh pairing code.",
  "The updated host companion did not connect. The saved pairing is preserved; run setup again to retry.",
])(
  "preserves a known setup failure without exposing other stderr",
  async (message) => {
    const fixture = fakeSetupProcess((child) => {
      child.stderr.write("sensitive earlier detail " + request.code + "\n");
      child.stderr.write(message + "\n");
      child.emit("close", 1);
    });
    await expect(
      installLocalMacCompanion(request, fixture.dependencies),
    ).rejects.toMatchObject({ code: "host_local_setup_failed", message });
  },
);

test("unknown stderr, URLs, and secrets never enter errors or logs", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const fixture = fakeSetupProcess((child) => {
    child.stderr.write("secret " + request.code);
    child.stdout.write("secret " + request.code);
    child.emit("close", 1);
  });
  const failure = await installLocalMacCompanion(
    request,
    fixture.dependencies,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(LocalCompanionSetupError);
  expect(String(failure)).not.toContain(request.code);
  expect(String(failure)).not.toContain(request.url);
  expect(log).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(errorLog).not.toHaveBeenCalled();
});

test("does not match a known error as an arbitrary substring", async () => {
  const fixture = fakeSetupProcess((child) => {
    child.stderr.write(
      "sensitive: The paired computer connection is missing. Reconnect from ABot Settings.",
    );
    child.emit("close", 1);
  });
  await expect(
    installLocalMacCompanion(request, fixture.dependencies),
  ).rejects.toMatchObject({
    code: "host_local_setup_failed",
    message:
      "Computer setup did not complete. Check the computer connection in ABot Settings before trying again.",
  });
});

test("bounds a child that never exits and stops its setup process group", async () => {
  const fixture = fakeSetupProcess(() => {});
  Object.defineProperty(fixture.child, "pid", { value: 456789 });
  let killed!: () => void;
  const killedSignal = new Promise<void>((resolve) => {
    killed = resolve;
  });
  const killProcessGroup = vi.fn(() => {
    killed();
  });
  let completed = false;
  const pending = installLocalMacCompanion(request, {
    ...fixture.dependencies,
    timeoutMs: 20,
    killProcessGroup,
  }).finally(() => {
    completed = true;
  });
  const rejection = expect(pending).rejects.toMatchObject({
    code: "host_local_setup_timeout",
  });
  await killedSignal;
  await new Promise((resolve) => setImmediate(resolve));
  expect(completed).toBe(false);
  fixture.child.emit("close", null);
  await rejection;
  expect(killProcessGroup).toHaveBeenCalledExactlyOnceWith(456789);
  expect(fixture.child.stdin.destroyed).toBe(true);
  expect(fixture.child.stdout.destroyed).toBe(true);
  expect(fixture.child.stderr.destroyed).toBe(true);
  expect(await readFile(bundlePath)).toEqual(bundle);
});

test("bounds a child that never reports termination after a kill", async () => {
  const fixture = fakeSetupProcess(() => {});
  Object.defineProperty(fixture.child, "pid", { value: 456789 });
  const killProcessGroup = vi.fn();
  await expect(
    installLocalMacCompanion(request, {
      ...fixture.dependencies,
      timeoutMs: 20,
      terminationTimeoutMs: 20,
      killProcessGroup,
    }),
  ).rejects.toMatchObject({ code: "host_local_setup_timeout" });
  expect(killProcessGroup).toHaveBeenCalledExactlyOnceWith(456789);
  expect(fixture.child.stdin.destroyed).toBe(true);
  expect(fixture.child.stdout.destroyed).toBe(true);
  expect(fixture.child.stderr.destroyed).toBe(true);
  expect(await readFile(bundlePath)).toEqual(bundle);
});

test.each(["stdout", "stderr"] as const)(
  "bounds excessive %s and kills setup",
  async (stream) => {
    const fixture = fakeSetupProcess((child) =>
      child[stream].write(Buffer.alloc(65_537)),
    );
    await expect(
      installLocalMacCompanion(request, fixture.dependencies),
    ).rejects.toMatchObject({ code: "host_local_setup_failed" });
    expect(fixture.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  },
);

test("bounds process launch and stdin errors without copying diagnostics", async () => {
  const fixture = fakeSetupProcess();
  fixture.launch.mockImplementationOnce(() => {
    throw new Error(request.code);
  });
  await expect(
    installLocalMacCompanion(request, fixture.dependencies),
  ).rejects.toMatchObject({ code: "host_local_setup_failed" });
  const stdinFailure = fakeSetupProcess((child) =>
    child.stdin.emit("error", new Error(request.code)),
  );
  await expect(
    installLocalMacCompanion(request, stdinFailure.dependencies),
  ).rejects.toMatchObject({ code: "host_local_setup_failed" });
});

test("the real child can run an inert stdin-only bundle without startup registration", async () => {
  const inert = Buffer.from(
    "process.stdin.resume(); process.stdin.once('end', () => process.exit(0));\n",
  );
  await expect(
    installLocalMacCompanion(
      { ...request, bundle: inert },
      {
        platform: "darwin",
        homeDir,
        timeoutMs: 5_000,
      },
    ),
  ).resolves.toBeUndefined();
});
