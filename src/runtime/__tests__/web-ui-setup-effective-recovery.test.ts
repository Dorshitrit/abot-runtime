import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
afterEach(async () => {
  await fixture?.cleanup();
});

test.each([
  "runner-step",
  "root-step",
  "root-invocation",
  "profile-calibration",
])(
  "a broken effective %s target reaches Configuration after a valid catalog read",
  async (kind) => {
    fixture = await createModelSetupFixture(
      ".codex/artifacts/pr71-save-repair-20260908/effective",
    );
    const registry = new RuntimeEnvironmentRegistry({
      rootDir: fixture.rootDir,
      configPath: fixture.configPath,
      defaultEnvironmentId: "prod",
    });
    expect(registry.modelCatalog("prod").availability.status).toBe("ready");
    const config = await fixture.readConfig();
    if (kind === "runner-step") {
      const path = resolve(
        dirname(fixture.configPath),
        config.requestRunner.configRef,
      );
      const runner = JSON.parse(await readFile(path, "utf8"));
      runner.models.defaults.steps["supervisor.response"] = "unknown-target";
      await writeFile(path, JSON.stringify(runner));
    } else {
      if (kind === "root-step")
        config.models.defaults = {
          steps: { "supervisor.response": "unknown-target" },
        };
      if (kind === "root-invocation")
        config.models.invocationProfiles = {
          broken: { profileId: "unknown-target" },
        };
      if (kind === "profile-calibration") {
        const ref = Object.values(config.models.profiles)[0] as {
          configRef: string;
        };
        const path = resolve(dirname(fixture.configPath), ref.configRef);
        const profile = JSON.parse(await readFile(path, "utf8"));
        profile.calibration = {
          ...profile.calibration,
          custom: { profileId: "unknown-target" },
        };
        await writeFile(path, JSON.stringify(profile));
      }
      await fixture.writeConfig(config);
    }
    expect(registry.modelCatalog("prod").availability).toMatchObject({
      status: "setup_required",
      recovery: "configuration",
    });
    const setup = new RuntimeSetupService({
      rootDir: fixture.rootDir,
      getConfigPath: () => fixture.configPath,
      activate: async () => ({ status: "ready" }),
    });
    expect(await setup.status()).toMatchObject({
      status: "required",
      recovery: "configuration",
    });
  },
);
