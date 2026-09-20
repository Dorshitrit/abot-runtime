import * as setupDraft from "../../web-ui/local-runtime/runtime-setup-draft.js";
import * as receiptFile from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { loadRuntimeConfig } from "../config.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const artifacts = resolve(
  ".codex/artifacts/pr71-recovery-guards-20260908/malformed-receipt",
);
const connection = {
  provider: "ollama",
  model: "original-chat",
  baseUrl: "http://127.0.0.1:11434",
  contextWindowTokens: 32768,
  deferActivation: true,
};
let rootDir = "";
let configPath: string | undefined;

function service() {
  return new RuntimeSetupService({
    rootDir,
    getConfigPath: () => configPath,
    configure: (path) => {
      configPath = path;
    },
    activate: async () => ({ status: "ready" }),
  });
}

async function unfinishedSetup() {
  const saved = await service().save(connection);
  const config = JSON.parse(await readFile(configPath!, "utf8"));
  config.models.profiles = {};
  await writeFile(configPath!, JSON.stringify(config));
  return saved.setup.editableConnection!.revision;
}

beforeEach(async () => {
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "receipt-"));
  configPath = undefined;
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

describe("malformed unfinished setup receipts", () => {
  test.each(["rename-failure", "concurrent-edit"])(
    "receipt replacement preserves external bytes on %s",
    async (failure) => {
      await unfinishedSetup();
      const receiptPath = configPath! + ".web-setup.json";
      const malformed = Buffer.from([0xff]);
      const external = Buffer.from([0xfe]);
      await writeFile(receiptPath, malformed);
      const beforeConfig = JSON.parse(await readFile(configPath!, "utf8"));
      const modelsPath = join(dirname(configPath!), "models");
      const beforeFiles = await readdir(modelsPath);
      const originalRename = receiptFile.rename;
      const originalWrite = receiptFile.writeFile;
      if (failure === "rename-failure")
        vi.spyOn(receiptFile, "rename").mockImplementation(async (from, to) => {
          if (to === receiptPath)
            throw new Error("fixture-receipt-rename-failed");
          await originalRename(from, to);
        });
      if (failure === "concurrent-edit")
        vi.spyOn(receiptFile, "writeFile").mockImplementation(
          async (path, data, options) => {
            await originalWrite(path, data, options);
            if (
              typeof path === "string" &&
              path.startsWith(receiptPath + ".") &&
              path.endsWith(".tmp")
            )
              await originalWrite(receiptPath, external);
          },
        );
      await expect(
        service().save({ ...connection, model: "recovered-chat" }),
      ).rejects.toThrow();
      expect(await readFile(receiptPath)).toEqual(
        failure === "rename-failure" ? malformed : external,
      );
      expect(JSON.parse(await readFile(configPath!, "utf8"))).toEqual(
        beforeConfig,
      );
      expect(await readdir(modelsPath)).toEqual(beforeFiles);
      expect(
        (await readdir(dirname(receiptPath))).some((file) =>
          file.endsWith(".tmp"),
        ),
      ).toBe(false);
    },
  );

  test("a recovered malformed receipt backup preserves invalid UTF-8 bytes exactly", async () => {
    await unfinishedSetup();
    const receiptPath = configPath! + ".web-setup.json";
    const bytes = Buffer.from([0xff, 0xfe, 0x7b]);
    await writeFile(receiptPath, bytes);
    await expect(
      service().save({ ...connection, model: "recovered-chat" }),
    ).resolves.toMatchObject({ setup: { status: "ready" } });
    const backups = (await readdir(dirname(receiptPath))).filter(
      (file) => file.includes(".web-setup.json.") && file.endsWith(".bak"),
    );
    const contents = await Promise.all(
      backups.map((file) => readFile(join(dirname(receiptPath), file))),
    );
    expect(contents.some((content) => content.equals(bytes))).toBe(true);
  });

  test.each(['{"version":', "[]", "{}", "null"])(
    "fresh setup replaces a malformed receipt while retaining its backup: %s",
    async (malformed) => {
      const revision = await unfinishedSetup();
      const receiptPath = configPath! + ".web-setup.json";
      await writeFile(receiptPath, malformed);
      const beforeConfig = await readFile(configPath!, "utf8");
      const orphanPath = join(
        dirname(configPath!),
        "models/default.config.json",
      );
      const beforeModel = await readFile(orphanPath, "utf8");
      expect((await service().status()).editableConnection).toBeUndefined();

      await expect(
        service().save({ ...connection, connectionRevision: revision }),
      ).rejects.toMatchObject({
        code: "setup_configuration_changed",
        statusCode: 409,
      });
      expect(await readFile(receiptPath, "utf8")).toBe(malformed);
      expect(await readFile(configPath!, "utf8")).toBe(beforeConfig);

      const recovered = await service().save({
        ...connection,
        model: "recovered-chat",
      });
      expect(recovered.setup.status).toBe("ready");
      expect(recovered.setup.editableConnection?.revision).toEqual(
        expect.any(String),
      );
      expect(recovered.setup.editableConnection?.revision).not.toBe(revision);
      expect(await readFile(orphanPath, "utf8")).toBe(beforeModel);
      expect(
        loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default
          .model,
      ).toBe("recovered-chat");
      const files = await readdir(dirname(receiptPath));
      const backups = files.filter(
        (file) => file.includes(".web-setup.json.") && file.endsWith(".bak"),
      );
      expect(
        await Promise.all(
          backups.map((file) =>
            readFile(join(dirname(receiptPath), file), "utf8"),
          ),
        ),
      ).toContain(malformed);
      await expect(
        service().save({
          ...connection,
          model: "edited-recovered-chat",
          connectionRevision: recovered.setup.editableConnection!.revision,
        }),
      ).resolves.toMatchObject({ setup: { status: "ready" } });
    },
  );

  test("a malformed receipt grants no authority to replace an existing provider", async () => {
    await unfinishedSetup();
    await writeFile(configPath! + ".web-setup.json", '{"version":');
    const before = await readFile(configPath!, "utf8");
    await expect(
      service().save({ ...connection, baseUrl: "http://127.0.0.1:11435" }),
    ).rejects.toMatchObject({
      code: "setup_provider_conflict",
      statusCode: 409,
    });
    expect(await readFile(configPath!, "utf8")).toBe(before);
    expect(await readFile(configPath! + ".web-setup.json", "utf8")).toBe(
      '{"version":',
    );
  });

  test("failure before replacement preserves malformed receipt and removes only new model files", async () => {
    await unfinishedSetup();
    const receiptPath = configPath! + ".web-setup.json";
    const malformed = '{"version":';
    await writeFile(receiptPath, malformed);
    const before = await readFile(configPath!, "utf8");
    const modelsPath = join(dirname(configPath!), "models");
    const files = await readdir(modelsPath);
    vi.spyOn(setupDraft, "createRuntimeSetupDraft").mockRejectedValueOnce(
      new Error("fixture-receipt-failed"),
    );
    await expect(
      service().save({ ...connection, model: "recovered-chat" }),
    ).rejects.toThrow("fixture-receipt-failed");
    expect(JSON.parse(await readFile(configPath!, "utf8"))).toEqual(
      JSON.parse(before),
    );
    expect(await readFile(receiptPath, "utf8")).toBe(malformed);
    expect(await readdir(modelsPath)).toEqual(files);
    await expect(
      service().save({ ...connection, model: "recovered-chat" }),
    ).resolves.toMatchObject({ setup: { status: "ready" } });
  });

  test.each(["directory", "symlink"])(
    "does not recover through an unsafe %s receipt",
    async (kind) => {
      await unfinishedSetup();
      const receiptPath = configPath! + ".web-setup.json";
      await rm(receiptPath);
      const target = join(rootDir, "external-receipt.json");
      await writeFile(target, "external-owner");
      if (kind === "directory") await mkdir(receiptPath);
      if (kind === "symlink") await symlink(target, receiptPath);
      const before = await readFile(configPath!, "utf8");
      await expect(service().save(connection)).rejects.toMatchObject({
        code: "setup_configuration_changed",
        statusCode: 409,
      });
      expect(await readFile(configPath!, "utf8")).toBe(before);
      expect(await readFile(target, "utf8")).toBe("external-owner");
    },
  );
});
