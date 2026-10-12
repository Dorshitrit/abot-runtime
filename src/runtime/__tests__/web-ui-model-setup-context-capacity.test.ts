import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeConfigValidationError } from "../config/validation.js";
import { ModelSetupContextWindowError } from "../../web-ui/local-runtime/model-setup-context-window.js";
import { ModelSetupService } from "../../web-ui/local-runtime/model-setup-service.js";
import { validateModelAddition } from "../../web-ui/local-runtime/model-setup-validation.js";
import {
  createInputValidationFixture,
  inputFixtureFileHashes,
  type InputValidationFixture,
} from "./support/input-validation-fixture.js";

let fixture: InputValidationFixture;
beforeEach(async () => {
  fixture = await createInputValidationFixture();
});
afterEach(async () => {
  await fixture.cleanup();
});

function add(contextWindowTokens: number) {
  return fixture.request(
    "POST",
    "runtime/config/models",
    JSON.stringify({
      profileId: "small-context",
      providerId: "ollama",
      model: "qa-small",
      contextWindowTokens,
    }),
  );
}

describe("add-model context capacity feedback", () => {
  test.each([4096, 6320])(
    "returns the added profile's safe constraint for %i without writes",
    async (tokens) => {
      const before = await inputFixtureFileHashes(fixture.rootDir);
      const response = await add(tokens);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const payload = await response.json();
      expect(payload).toMatchObject({
        ok: false,
        error: "context_window_too_small",
        credentialSaved: false,
        contextWindow: {
          field: "contextWindowTokens",
          profileId: "small-context",
          declaredTokens: tokens,
          effectiveTokens: tokens,
          reservedTokens: 6320,
          minimumTokens: 6321,
        },
      });
      expect(JSON.stringify(payload)).not.toContain(fixture.rootDir);
      expect(JSON.stringify(payload)).not.toContain("runtime.config.json");
      expect(await inputFixtureFileHashes(fixture.rootDir)).toEqual(before);
      expect((await fixture.request("GET", "health")).status).toBe(200);
    },
  );

  test("accepts 6321 after correcting the exact rejected request", async () => {
    expect((await add(4096)).status).toBe(400);
    const response = await add(6321);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      model: { profileId: "small-context", model: "qa-small" },
      restartRequired: true,
    });
    expect(await fixture.readModelProfile("small-context")).toMatchObject({
      contextWindowTokens: 6321,
    });
  });

  test("uses current runner and format reserves and identifies the environment", async () => {
    const config = await fixture.readConfig();
    const runnerPath = resolve(
      dirname(fixture.configPath),
      config.requestRunner.configRef,
    );
    const runner = JSON.parse(await readFile(runnerPath, "utf8"));
    runner.context = {
      ...runner.context,
      outputReserveTokens: 2048,
      safetyReserveTokens: 512,
      attachmentReserveTokens: 256,
    };
    config.environment = { default: "review", profiles: { review: {} } };
    config.models.defaults = {
      ...config.models.defaults,
      context: {
        formatTokenAccounting: { mode: "estimate", fixedOverheadTokens: 80 },
      },
    };
    const dynamicRunnerPath = resolve(
      dirname(fixture.configPath),
      "dynamic-runner.config.json",
    );
    await writeFile(dynamicRunnerPath, JSON.stringify(runner));
    config.requestRunner.configRef = "./dynamic-runner.config.json";
    await fixture.writeConfig(config);
    const before = await inputFixtureFileHashes(fixture.rootDir);
    const response = await add(2896);
    expect(response.status).toBe(400);
    expect((await response.json()).contextWindow).toMatchObject({
      profileId: "small-context",
      declaredTokens: 2896,
      reservedTokens: 2896,
      minimumTokens: 2897,
      environmentId: "review",
    });
    expect(await inputFixtureFileHashes(fixture.rootDir)).toEqual(before);
    expect((await add(2897)).status).toBe(200);
  });

  test("projects a lower effective Ollama allocation for the added profile", async () => {
    const config = await fixture.readConfig();
    config.models.profiles["small-context"] = {
      ...(await fixture.readModelProfile("default")),
      model: "qa-small",
      contextWindowTokens: 32768,
      options: { num_ctx: 4096 },
    };
    const before = await inputFixtureFileHashes(fixture.rootDir);
    await expect(
      validateModelAddition(config, {
        rootDir: fixture.rootDir,
        configPath: fixture.configPath,
        modelProfileId: "small-context",
      }),
    ).rejects.toMatchObject({
      code: "context_window_too_small",
      statusCode: 400,
      contextWindow: {
        profileId: "small-context",
        declaredTokens: 32768,
        effectiveTokens: 4096,
        allocationTokens: 4096,
        reservedTokens: 6320,
        minimumTokens: 6321,
      },
    });
    expect(await inputFixtureFileHashes(fixture.rootDir)).toEqual(before);
  });

  test("does not attribute another profile's capacity error to the added profile", async () => {
    const config = await fixture.readConfig();
    const profile = await fixture.readModelProfile("default");
    config.models.profiles.unrelated = {
      ...profile,
      contextWindowTokens: 4096,
    };
    config.models.profiles["small-context"] = {
      ...profile,
      contextWindowTokens: 32768,
    };
    let failure: unknown;
    try {
      await validateModelAddition(config, {
        rootDir: fixture.rootDir,
        configPath: fixture.configPath,
        modelProfileId: "small-context",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RuntimeConfigValidationError);
    expect(failure).not.toBeInstanceOf(ModelSetupContextWindowError);
  });

  test("keeps unrelated validation and unexpected errors redacted", async () => {
    for (const error of [
      new Error("synthetic-private /private/config.json"),
      new RuntimeConfigValidationError("/private/config.json", [
        "synthetic-private",
      ]),
    ]) {
      vi.spyOn(ModelSetupService.prototype, "add").mockRejectedValueOnce(error);
      const response = await add(8192);
      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error).toBe("model_setup_failed");
      expect(payload.contextWindow).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain("synthetic-private");
      expect(JSON.stringify(payload)).not.toContain("/private/");
    }
  });
});
