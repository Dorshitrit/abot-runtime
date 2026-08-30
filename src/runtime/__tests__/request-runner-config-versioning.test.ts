import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { REQUEST_INVOKED_STEP_IDS } from "../config/runner/contracts.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import { LEGACY_REQUEST_INVOKED_STEP_IDS } from "../config/runner/schema-version.js";

const temporaryRoots: string[] = [];
const publicV1FixturePath = join(
  import.meta.dirname,
  "fixtures",
  "public-v1.0.0",
  "request-runner.config.example.json",
);
const publicV1ModelFixturePath = join(
  import.meta.dirname,
  "fixtures",
  "public-v1.0.0",
  "models",
  "default.config.json",
);
const publicV1FixtureSha256 =
  "e88c1761f48babe4845fb2ad53b4dc461e2f8d0c5e81650f9d2cda772faf2483";
const publicV1ModelFixtureSha256 =
  "1dccf64df8fe0b966243861600911d71120fb704dbc1dd6ecab50e7ccc44ebd8";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createRawConfigPath(raw: string): string {
  const rootDir = mkdtempSync(join(tmpdir(), "request-runner-versioning-"));
  temporaryRoots.push(rootDir);
  const configPath = join(rootDir, "request-runner.config.json");
  writeFileSync(configPath, raw);
  return configPath;
}

function createConfigPath(config: unknown): string {
  return createRawConfigPath(JSON.stringify(config, null, 2) + "\n");
}

function readPublicV1Fixture(): {
  raw: string;
  parsed: Record<string, unknown>;
} {
  const raw = readFileSync(publicV1FixturePath, "utf-8");
  return {
    raw,
    parsed: JSON.parse(raw) as Record<string, unknown>,
  };
}

function createSparseV2Config(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    models: {
      defaults: {
        profileId: "default",
        steps: {
          "supervisor.response": "default",
          "worker.result": "default",
          "execution.response": "default",
          "tool_payload.raw": "toolPayload.raw",
        },
      },
    },
    context: {
      outputReserveTokens: 4_096,
      safetyReserveTokens: 1_200,
      attachmentReserveTokens: 1_024,
    },
    stepDefaults: {
      timeoutMs: 90_000,
    },
    steps: {},
  };
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("request runner config versioning", () => {
  test("loads the exact public 1.0.0 config without rewriting it", () => {
    const fixture = readPublicV1Fixture();
    expect(sha256(fixture.raw)).toBe(publicV1FixtureSha256);
    const rawModels = fixture.parsed.models as {
      defaults: { steps: Record<string, unknown> };
    };
    expect(Object.keys(rawModels.defaults.steps)).toEqual([
      ...LEGACY_REQUEST_INVOKED_STEP_IDS,
    ]);
    expect(
      Object.keys(fixture.parsed.steps as Record<string, unknown>),
    ).toEqual([...LEGACY_REQUEST_INVOKED_STEP_IDS]);
    const configPath = createRawConfigPath(fixture.raw);
    const before = readFileSync(configPath, "utf-8");

    const loaded = loadRequestRunnerConfig({ configPath });

    expect(loaded.models.defaults.steps["capability.controls"]).toBe(
      "capability.controls",
    );
    expect(loaded.steps["capability.controls"]?.timeoutMs).toBe(90_000);
    expect(Object.keys(loaded.models.defaults.steps)).toEqual([
      ...REQUEST_INVOKED_STEP_IDS,
    ]);
    expect(Object.keys(loaded.steps)).toEqual([...REQUEST_INVOKED_STEP_IDS]);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  test("pins the exact public 1.0.0 model calibration fixture", () => {
    const raw = readFileSync(publicV1ModelFixturePath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const calibration = config.calibration as Record<string, unknown>;

    expect(sha256(raw)).toBe(publicV1ModelFixtureSha256);
    expect(calibration).not.toHaveProperty("capability.controls");
  });

  test("normalizes equivalent legacy and sparse v2 files identically", () => {
    const legacyPath = createConfigPath(readPublicV1Fixture().parsed);
    const sparseV2Path = createConfigPath(createSparseV2Config());

    expect(loadRequestRunnerConfig({ configPath: sparseV2Path })).toEqual(
      loadRequestRunnerConfig({ configPath: legacyPath }),
    );
  });

  test("applies sparse timeout and instruction overrides on top of v2 defaults", () => {
    const config = createSparseV2Config();
    const steps = config.steps as Record<string, unknown>;
    steps["context.compact"] = { timeoutMs: 180_000 };
    steps["supervisor.response"] = {
      instructionRefs: ["./response.md"],
    };
    const configPath = createConfigPath(config);
    writeFileSync(
      join(dirname(configPath), "response.md"),
      "# Response\n\nClear.",
    );

    const loaded = loadRequestRunnerConfig({ configPath });

    expect(loaded.steps["context.compact"]?.timeoutMs).toBe(180_000);
    expect(loaded.steps["supervisor.response"]?.timeoutMs).toBe(90_000);
    expect(
      loaded.steps["supervisor.response"]?.instructionBlocks?.map(
        (block) => block.ref,
      ),
    ).toEqual(["./response.md"]);
  });

  test.each([1, 3, "2", null])(
    "rejects unsupported explicit schema version %j",
    (schemaVersion) => {
      const config = createSparseV2Config();
      config.schemaVersion = schemaVersion;

      expect(() =>
        loadRequestRunnerConfig({ configPath: createConfigPath(config) }),
      ).toThrow("schemaVersion must be 2 or omitted for the legacy v1 format");
    },
  );

  test("rejects unregistered sparse step overrides", () => {
    const config = createSparseV2Config();
    (config.steps as Record<string, unknown>)["future.typo"] = {
      timeoutMs: 10_000,
    };

    expect(() =>
      loadRequestRunnerConfig({ configPath: createConfigPath(config) }),
    ).toThrow("steps contains unregistered model step future.typo");
  });
});
