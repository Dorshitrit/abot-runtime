import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setRuntimePluginEnabled } from "../../web-ui/plugin-management-service.js";
import {
  getConfigDashboardSnapshot,
  saveConfigDashboardFile,
} from "../../web-ui/config-dashboard-backend.js";
import {
  applyBarrier,
  createApplyFixture,
  type ApplyFixture,
} from "./support/web-ui-apply-fixture.js";

vi.mock("../local-application.js", () => ({
  createLocalRuntimeApplication: vi.fn(),
}));
let fixture: ApplyFixture;
let child: ChildProcess | undefined;
beforeEach(async () => {
  fixture = await createApplyFixture(
    ".codex/artifacts/pr71-save-repair-20260908/apply",
  );
});
afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
  child = undefined;
  await fixture.cleanup();
});

function holdGatewayActivation(failure?: Error) {
  const entered = applyBarrier();
  const resume = applyBarrier();
  fixture.activate.mockImplementationOnce(async () => {
    entered.release();
    await resume.waiting;
    if (failure) throw failure;
    return { status: "ready" };
  });
  const applying = fixture.registry.applyConfiguration().catch((error) => error);
  return { entered, resume, applying };
}

async function saveAfterApply(kind: "model" | "plugin" | "runner") {
  if (kind === "model")
    return fixture.service.add({
      profileId: "queued",
      providerId: "ollama",
      model: "queued-model",
    });
  const options = { rootDir: fixture.rootDir, configPath: fixture.configPath };
  if (kind === "plugin")
    return setRuntimePluginEnabled(options, {
      pluginId: "filesystem",
      enabled: false,
    });
  const runner = (await getConfigDashboardSnapshot(options)).files.requestRunner!;
  return saveConfigDashboardFile({
    ...options,
    kind: "requestRunner",
    config: { ...runner.config, stepDefaults: { timeoutMs: 12345 } },
    expectedRevision: runner.revision,
  });
}

test.each(["model", "plugin", "runner"] as const)(
  "a %s save remains queued throughout an Apply longer than the store lock timeout",
  async (kind) => {
    const held = holdGatewayActivation();
    await held.entered.waiting;
    let settled = false;
    const saving = saveAfterApply(kind).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    let settledBeforeRelease: boolean;
    try {
      await delay(2_200);
      settledBeforeRelease = settled;
    } finally {
      held.resume.release();
    }
    expect(await held.applying).toEqual({ status: "ready" });
    expect(await saving).toBeUndefined();
    expect(settledBeforeRelease!).toBe(false);
    const config = await fixture.readConfig();
    if (kind === "model") expect(config.models.profiles).toHaveProperty("queued");
    if (kind === "plugin") expect(config.plugins.deny).toContain("filesystem");
    if (kind === "runner")
      expect((await fixture.readRunner()).stepDefaults.timeoutMs).toBe(12345);
  },
);

test("a rejected slow Apply releases queued saves after restoring prior owners", async () => {
  const failure = new Error("fixture gateway activation failed");
  const previous = fixture.owners[0]!.services.config;
  const held = holdGatewayActivation(failure);
  await held.entered.waiting;
  const saving = saveAfterApply("model").catch((error: unknown) => error);
  try {
    await delay(2_200);
  } finally {
    held.resume.release();
  }
  expect(await held.applying).toBe(failure);
  expect(await saving).toMatchObject({ model: { profileId: "queued" } });
  expect(fixture.registry.get("prod").services.config).toBe(previous);
  await expect(fixture.registry.applyConfiguration()).resolves.toEqual({ status: "ready" });
  expect(fixture.registry.get("prod").services.config.models?.profiles).toHaveProperty("queued");
});

test("an independent process using a config alias waits for slow Apply release", async () => {
  const alias = join(dirname(fixture.configPath), "alias.config.json");
  await symlink(fixture.configPath, alias);
  const moduleUrl = pathToFileURL(resolve("src/runtime/adapters/config-file-transaction.ts")).href;
  const held = holdGatewayActivation();
  await held.entered.waiting;
  child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    `import {withConfigFileTransaction} from ${JSON.stringify(moduleUrl)}; process.stdout.write("attempting"); await withConfigFileTransaction(${JSON.stringify(alias)}, async transaction => { await transaction.write({...transaction.snapshot.config, child: true}); });`,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const exited = once(child, "exit");
  let exitBeforeRelease: number | null;
  try {
    await once(child.stdout!, "data");
    await delay(2_200);
    exitBeforeRelease = child.exitCode;
  } finally {
    held.resume.release();
  }
  expect(await held.applying).toEqual({ status: "ready" });
  await exited;
  expect(stderr).toBe("");
  expect(child.exitCode).toBe(0);
  expect(exitBeforeRelease!).toBeNull();
  expect((await fixture.readConfig()).child).toBe(true);
});

test("a config save reclaims the canonical lock after its owning process exits", async () => {
  const moduleUrl = pathToFileURL(resolve("src/runtime/adapters/long-term-memory/file-lock.ts")).href;
  child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    `import {withFileLock} from ${JSON.stringify(moduleUrl)}; await withFileLock(${JSON.stringify(fixture.configPath + ".config.lock")}, async () => { process.exit(0); });`,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  await once(child, "exit");
  expect(stderr).toBe("");
  expect(child.exitCode).toBe(0);
  await expect(saveAfterApply("model")).resolves.toMatchObject({
    model: { profileId: "queued" },
  });
});
