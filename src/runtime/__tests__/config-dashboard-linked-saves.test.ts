import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as transactions from "../adapters/config-file-transaction.js";
import {
  getConfigDashboardSnapshot,
  saveConfigDashboardFile,
} from "../../web-ui/config-dashboard-backend.js";

let rootDir: string;
let configPath: string;
const model = { model: "original", contextWindowTokens: 32768 };
const runner = {
  schemaVersion: 2,
  models: {
    defaults: {
      profileId: "primary",
      steps: { "tool_payload.raw": "toolPayload.raw" },
    },
  },
  context: {
    outputReserveTokens: 4096,
    safetyReserveTokens: 1200,
    attachmentReserveTokens: 1024,
  },
  stepDefaults: { timeoutMs: 20000 },
  steps: {},
};
const options = () => ({ rootDir, configPath });
const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));
const writeJson = (path: string, config: unknown) =>
  writeFile(path, JSON.stringify(config));
function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((done) => {
    release = done;
  });
  return { waiting, release };
}
beforeEach(async () => {
  const artifacts = resolve(
    ".codex/artifacts/pr71-second-review-20260908/dashboard-linked-saves",
  );
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "fixture-"));
  configPath = join(rootDir, "runtime.json");
  await mkdir(join(rootDir, "models"));
  await mkdir(join(rootDir, "runner"));
  await writeJson(configPath, {
    models: {
      profiles: { primary: { configRef: "./models/a.json" }, inline: model },
    },
    requestRunner: { configRef: "./runner/a.json" },
  });
  for (const name of ["a", "b"]) {
    await writeJson(join(rootDir, "models", `${name}.json`), model);
    await writeJson(join(rootDir, "runner", `${name}.json`), runner);
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

test.each(["model", "requestRunner"] as const)(
  "%s save resolves its target only after the concurrent Runtime transaction commits",
  async (kind) => {
    const snapshot = await getConfigDashboardSnapshot(options());
    const target =
      kind === "model"
        ? snapshot.files.models.find(({ id }) => id === "primary")!
        : snapshot.files.requestRunner!;
    const directory = kind === "model" ? "models" : "runner";
    const candidate =
      kind === "model"
        ? { ...model, contextWindowTokens: 65536 }
        : { ...runner, stepDefaults: { timeoutMs: 30000 } };
    const nextRuntime = structuredClone(snapshot.files.runtime.config);
    if (kind === "model")
      (
        nextRuntime.models as { profiles: Record<string, unknown> }
      ).profiles.primary = { configRef: "./models/b.json" };
    else nextRuntime.requestRunner = { configRef: "./runner/b.json" };
    const attempted = barrier();
    const resume = barrier();
    const original = transactions.withConfigFileTransaction;
    let intercepted = false;
    vi.spyOn(transactions, "withConfigFileTransaction").mockImplementation(
      async (path, operation) => {
        if (!intercepted) {
          intercepted = true;
          attempted.release();
          await resume.waiting;
        }
        return original(path, operation);
      },
    );
    let pending!: Promise<unknown>;
    try {
      await original(configPath, async (transaction) => {
        pending = saveConfigDashboardFile({
          ...options(),
          kind,
          id: target.id,
          config: candidate,
          expectedRevision: target.revision,
        }).then(
          () => null,
          (error: unknown) => error,
        );
        await attempted.waiting;
        await saveConfigDashboardFile({
          ...options(),
          kind: "runtime",
          config: nextRuntime,
          expectedRevision: snapshot.files.runtime.revision,
          transaction,
        });
      });
    } finally {
      resume.release();
    }
    expect(await pending).toBeInstanceOf(transactions.ConfigFileConflictError);
    expect(await readJson(configPath)).toEqual(nextRuntime);
    expect(await readJson(join(rootDir, directory, "a.json"))).toEqual(
      target.config,
    );
    expect(await readJson(join(rootDir, directory, "b.json"))).toEqual(
      target.config,
    );
  },
);

test.each(["runtime", "inline"] as const)(
  "%s save reuses a supplied canonical Runtime transaction through an alias",
  async (target) => {
    const alias = join(rootDir, "runtime-alias.json");
    await symlink(configPath, alias);
    const snapshot = await getConfigDashboardSnapshot(options());
    const file =
      target === "runtime"
        ? snapshot.files.runtime
        : snapshot.files.models.find(({ id }) => id === "inline")!;
    const candidate =
      target === "runtime"
        ? { ...file.config, webUi: { openOnRuntimeServiceStart: true } }
        : { ...file.config, contextWindowTokens: 65536 };
    await transactions.withConfigFileTransaction(configPath, (transaction) =>
      saveConfigDashboardFile({
        rootDir,
        configPath: alias,
        kind: file.kind,
        id: file.id,
        config: candidate,
        expectedRevision: file.revision,
        transaction,
      }),
    );
    const actual = await readJson(configPath);
    expect(
      target === "runtime" ? actual : actual.models.profiles.inline,
    ).toEqual(candidate);
  },
);

test("a linked save reuses its supplied root transaction and canonical child alias", async () => {
  const alias = join(rootDir, "models", "alias.json");
  const childPath = join(rootDir, "models", "a.json");
  await symlink(childPath, alias);
  const root = await readJson(configPath);
  root.models.profiles.primary.configRef = "./models/alias.json";
  await writeJson(configPath, root);
  const snapshot = await getConfigDashboardSnapshot(options());
  const file = snapshot.files.models.find(({ id }) => id === "primary")!;
  const candidate = { ...file.config, contextWindowTokens: 65536 };
  await transactions.withConfigFileTransaction(configPath, (transaction) =>
    saveConfigDashboardFile({
      ...options(),
      kind: "model",
      id: "primary",
      config: candidate,
      expectedRevision: file.revision,
      transaction,
    }),
  );
  expect(await readJson(childPath)).toEqual(candidate);
  expect(await readJson(alias)).toEqual(candidate);
});

test("an aliased child that is the Runtime file reuses the root transaction", async () => {
  const root = await readJson(configPath);
  root.models.profiles.primary.configRef = "./runtime-alias.json";
  await writeJson(configPath, root);
  await symlink(configPath, join(rootDir, "runtime-alias.json"));
  const snapshot = await getConfigDashboardSnapshot(options());
  const file = snapshot.files.models.find(({ id }) => id === "primary")!;
  const candidate = {
    ...file.config,
    webUi: { openOnRuntimeServiceStart: true },
  };
  await saveConfigDashboardFile({
    ...options(),
    kind: "model",
    id: "primary",
    config: candidate,
    expectedRevision: file.revision,
  });
  expect(await readJson(configPath)).toEqual(candidate);
});

test("a child-only supplied transaction is rejected before attempting a root lock", async () => {
  const snapshot = await getConfigDashboardSnapshot(options());
  const file = snapshot.files.models.find(({ id }) => id === "primary")!;
  await transactions.withConfigFileTransaction(
    join(rootDir, "models", "a.json"),
    async (transaction) => {
      const acquire = vi.spyOn(transactions, "withConfigFileTransaction");
      await expect(
        saveConfigDashboardFile({
          ...options(),
          kind: "model",
          id: "primary",
          config: model,
          expectedRevision: file.revision,
          transaction,
        }),
      ).rejects.toThrow("Runtime configuration transaction");
      expect(acquire).not.toHaveBeenCalled();
    },
  );
});

test("the root guard retains child revision conflicts", async () => {
  const snapshot = await getConfigDashboardSnapshot(options());
  const file = snapshot.files.models.find(({ id }) => id === "primary")!;
  const childPath = join(rootDir, "models", "a.json");
  const changed = { ...model, contextWindowTokens: 65536 };
  await transactions.withConfigFileTransaction(childPath, (transaction) =>
    transaction.write(changed),
  );
  await expect(
    saveConfigDashboardFile({
      ...options(),
      kind: "model",
      id: "primary",
      config: model,
      expectedRevision: file.revision,
    }),
  ).rejects.toBeInstanceOf(transactions.ConfigFileConflictError);
  expect(await readJson(childPath)).toEqual(changed);
});
