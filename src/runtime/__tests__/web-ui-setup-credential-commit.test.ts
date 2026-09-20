import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import * as draftFiles from "../../web-ui/local-runtime/runtime-setup-draft.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

let fixture: ModelSetupFixture;
let service: RuntimeSetupService;
let original: Awaited<ReturnType<typeof snapshot>>;
const request = {
  provider: "openai",
  model: "cloud-chat",
  apiKey: "fixture-replacement-key",
  deferActivation: true,
};
const originalKey = "fixture-original-key";

async function snapshot() {
  const directory = join(fixture.rootDir, "local/models");
  const names = (await fs.readdir(directory))
    .filter((name) => name.endsWith(".config.json"))
    .sort();
  return {
    config: await fixture.readConfig(),
    credential: await fixture.readEnv(),
    receipt: await fs.readFile(fixture.configPath + ".web-setup.json", "utf8"),
    models: await Promise.all(
      names.map(async (name) => [
        name,
        await fs.readFile(join(directory, name), "utf8"),
      ]),
    ),
  };
}

beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-save-repair-20260908/credential",
  );
  service = new RuntimeSetupService({
    rootDir: fixture.rootDir,
    getConfigPath: () => fixture.configPath,
    activate: async () => ({ status: "ready" }),
  });
  const draft = await draftFiles.readRuntimeSetupDraft(fixture.configPath);
  await service.save({
    ...request,
    apiKey: originalKey,
    connectionRevision: draft!.revision,
  });
  const config = await fixture.readConfig();
  config.models.profiles = {};
  config.models.embeddingProfiles = {
    selected: { provider: "openai", model: "fixture-embedding" },
  };
  config.longTermMemory = { enabled: true, embeddingProfileId: "selected" };
  config.logging = { ...config.logging, enabled: false };
  await fixture.writeConfig(config);
  original = await snapshot();
});
afterEach(async () => fixture.cleanup());

describe("stale setup recovery credential commit", () => {
  test("restores an originally absent credential file when the configuration commit fails", async () => {
    await fs.rm(fixture.envPath);
    vi.spyOn(draftFiles, "createRuntimeSetupDraft").mockRejectedValueOnce(
      new Error("fixture receipt unavailable"),
    );
    await expect(service.save(request)).rejects.toThrow(
      "fixture receipt unavailable",
    );
    await expect(fs.readFile(fixture.envPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fixture.readConfig()).toEqual(original.config);
    expect(
      await fs.readFile(fixture.configPath + ".web-setup.json", "utf8"),
    ).toBe(original.receipt);
    expect(process.env.OPENAI_API_KEY).toBe(originalKey);
  });

  test("retains the credential failure and cleanup failure when its private temporary file cannot be removed", async () => {
    const rename = fs.rename;
    const remove = fs.rm;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === fixture.envPath)
        throw new Error("fixture rename unavailable");
      return rename(from, to);
    });
    vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (
        String(path).startsWith(fixture.envPath + ".") &&
        String(path).endsWith(".tmp")
      )
        throw new Error("fixture cleanup unavailable");
      return remove(path, options);
    });
    const error = await service
      .save(request)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "fixture rename unavailable" }),
      expect.objectContaining({ message: "fixture cleanup unavailable" }),
    ]);
    expect(await snapshot()).toEqual(original);
    expect(process.env.OPENAI_API_KEY).toBe(originalKey);
    const temporary = (await fs.readdir(fixture.rootDir)).find(
      (name) => name.startsWith(".env.") && name.endsWith(".tmp"),
    );
    expect(temporary).toBeTruthy();
    expect(
      (await fs.stat(join(fixture.rootDir, temporary!))).mode & 0o777,
    ).toBe(0o600);
  });

  test("preserves memory, receipt, model files and the effective key when credential rename fails", async () => {
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === fixture.envPath)
        throw new Error("fixture credential rename failed");
      return rename(from, to);
    });
    await expect(service.save(request)).rejects.toThrow(
      "fixture credential rename failed",
    );
    expect(await snapshot()).toEqual(original);
    expect((await fixture.readConfig()).longTermMemory.enabled).toBe(true);
    expect(process.env.OPENAI_API_KEY).toBe(originalKey);
  });

  test("preserves a concurrent credential edit without disabling memory or replacing the stale receipt", async () => {
    const chmod = fs.chmod;
    const concurrent = original.credential + "CONCURRENT_SETTING=preserved\n";
    let edited = false;
    vi.spyOn(fs, "chmod").mockImplementation(async (path, mode) => {
      if (!edited && String(path).startsWith(fixture.envPath + ".")) {
        edited = true;
        await fs.writeFile(fixture.envPath, concurrent);
      }
      return chmod(path, mode);
    });
    await expect(service.save(request)).rejects.toMatchObject({
      code: "setup_credentials_changed",
      statusCode: 409,
    });
    expect(await snapshot()).toEqual({ ...original, credential: concurrent });
    expect(process.env.OPENAI_API_KEY).toBe(originalKey);
  });

  test.each(["config", "receipt"])(
    "restores the credential if the subsequent %s commit fails",
    async (target) => {
      const rename = fs.rename;
      const failingPath =
        fixture.configPath + (target === "receipt" ? ".web-setup.json" : "");
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(to) === failingPath)
          throw new Error("fixture " + target + " rename failed");
        return rename(from, to);
      });
      await expect(service.save(request)).rejects.toThrow(
        "fixture " + target + " rename failed",
      );
      expect(await snapshot()).toEqual(original);
      expect(process.env.OPENAI_API_KEY).toBe(originalKey);
    },
  );

  test("reports both the commit failure and blocked credential rollback while preserving an external credential update", async () => {
    const concurrent = original.credential + "CONCURRENT_SETTING=preserved\n";
    vi.spyOn(draftFiles, "createRuntimeSetupDraft").mockImplementationOnce(
      async () => {
        await fs.writeFile(fixture.envPath, concurrent);
        throw new Error("fixture receipt write failed");
      },
    );
    const error = await service
      .save(request)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "fixture receipt write failed" }),
      expect.objectContaining({ code: "setup_credentials_changed" }),
    ]);
    expect(await snapshot()).toEqual({ ...original, credential: concurrent });
    expect(process.env.OPENAI_API_KEY).toBe(originalKey);
  });

  test("keeps concurrent config edits and reports rollback failure instead of silently overwriting them", async () => {
    let concurrent: Record<string, unknown> = {};
    vi.spyOn(draftFiles, "createRuntimeSetupDraft").mockImplementationOnce(
      async () => {
        concurrent = {
          ...(await fixture.readConfig()),
          logging: { enabled: true },
        };
        await fixture.writeConfig(concurrent);
        throw new Error("fixture receipt write failed");
      },
    );
    const error = await service
      .save(request)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "fixture receipt write failed" }),
      expect.objectContaining({ code: "config_changed" }),
    ]);
    expect(await fixture.readConfig()).toEqual(concurrent);
    expect(await fixture.readEnv()).toBe(original.credential);
    expect(
      await fs.readFile(fixture.configPath + ".web-setup.json", "utf8"),
    ).toBe(original.receipt);
    const profile = (concurrent.models as any).profiles.default;
    await expect(
      fs.readFile(join(fixture.rootDir, "local", profile.configRef), "utf8"),
    ).resolves.toContain("cloud-chat");
    expect(process.env.OPENAI_API_KEY).toBe(originalKey);
  });

  test("commits the credential and invalidation together and publishes a matching usable receipt", async () => {
    const result = await service.save(request);
    expect(result.embeddingInvalidated).toBe(true);
    expect((await fixture.readConfig()).longTermMemory.enabled).toBe(false);
    expect(await fixture.readEnv()).toContain(request.apiKey);
    expect(process.env.OPENAI_API_KEY).toBe(request.apiKey);
    expect(JSON.stringify(result)).not.toContain(request.apiKey);
    expect(result.setup.editableConnection?.revision).toBeTruthy();
    const before = original.config;
    const after = await fixture.readConfig();
    expect(after.models.providers).toEqual(before.models.providers);
    expect(after.models.embeddingProfiles).toEqual(
      before.models.embeddingProfiles,
    );
    expect(after.logging).toEqual(before.logging);
  });
});
