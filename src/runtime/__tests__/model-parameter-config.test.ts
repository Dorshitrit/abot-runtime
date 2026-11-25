import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildModelGenerationConfig,
  buildRuntimeModelConfiguration,
} from "../config/builders.js";
import { validateModelGenerationConfig } from "../config/validation/model-invocation-config-validation.js";
import { modelGenerationSchema } from "../config/model-generation-schema.js";
import { createRequestModelPolicy } from "../config/runner/model-policy.js";
import { mergeModelProfileSources } from "../config/model-profile-sources.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "parameter-config-"));
  temporaryDirectories.push(directory);
  const mainConfigPath = join(directory, "runtime.config.json");
  return { directory, mainConfigPath };
}

describe("canonical generation configuration", () => {
  test("round-trips omit, inherit and explicit zero without converting legacy scalars", () => {
    const generation = {
      temperature: 0.7,
      reasoningEffort: "none",
      parameters: {
        top_k: { mode: "value", value: 0 },
        seed: { mode: "value", value: 0 },
        top_p: { mode: "omit" },
        min_p: { mode: "inherit" },
      },
    };
    expect(
      buildModelGenerationConfig(JSON.parse(JSON.stringify(generation))),
    ).toEqual(generation);
    const issues: string[] = [];
    validateModelGenerationConfig(issues, generation, "generation");
    expect(issues).toEqual([]);
  });

  test.each([
    { parameters: { top_k: { mode: "value", value: 0.5 } } },
    { parameters: { top_p: { mode: "omit", value: 0.2 } } },
    { parameters: { top_p: { mode: "value", value: 2 } } },
    { parameters: { max_output_tokens: { mode: "value", value: 0 } } },
    { parameters: { unregistered: { mode: "value", value: 1 } } },
  ])("rejects malformed canonical controls %j", (generation) => {
    const issues: string[] = [];
    validateModelGenerationConfig(issues, generation, "generation");
    expect(issues).toHaveLength(1);
    expect(() => buildModelGenerationConfig(generation)).toThrow();
  });

  test("keeps the legacy output-token field forbidden while accepting the new control", () => {
    const oldIssues: string[] = [];
    validateModelGenerationConfig(
      oldIssues,
      { maxOutputTokens: 100 },
      "generation",
    );
    expect(oldIssues[0]).toContain("maxOutputTokens is not supported");
    const newIssues: string[] = [];
    validateModelGenerationConfig(
      newIssues,
      { parameters: { max_output_tokens: { mode: "value", value: 100 } } },
      "generation",
    );
    expect(newIssues).toEqual([]);
  });

  test("normalizes spellings per source before overlaying and retains derived warnings", () => {
    const source = mergeModelProfileSources(
      {
        generation: {
          temperature: 0.2,
          parameters: {
            temperature: { mode: "value", value: 0.4 },
            top_k: { mode: "value", value: 0 },
          },
        },
        calibration: {
          response: {
            generation: { topP: 0.8, parameters: { top_p: { mode: "omit" } } },
          },
        },
      },
      {
        generation: {
          temperature: 0.9,
          parameters: { top_k: { mode: "inherit" } },
        },
      },
    );
    expect(source.generation?.temperature).toBe(0.9);
    expect(source.generation?.parameters).toEqual({
      top_k: { mode: "value", value: 0 },
    });
    expect(source.generation?.parameterDiagnostics?.[0].code).toBe(
      "model_parameter_alias_shadowed",
    );
    expect(
      source.calibration?.response.generation?.parameterDiagnostics?.[0].key,
    ).toBe("top_p");
  });

  test("cannot inject diagnostics through raw config JSON", () => {
    const source = mergeModelProfileSources(
      {},
      {
        generation: {
          parameterDiagnostics: [{ code: "forged", message: "forged" }],
          temperature: 0.7,
        },
      },
    );
    expect(source.generation?.parameterDiagnostics).toBeUndefined();
  });

  test("the generation schema documents tri-state canonical controls", () => {
    const generation = modelGenerationSchema() as {
      properties: {
        parameters: {
          additionalProperties: boolean;
          properties: Record<string, { oneOf: unknown[] }>;
        };
      };
    };
    expect(generation.properties.parameters.additionalProperties).toBe(false);
    expect(
      generation.properties.parameters.properties.max_output_tokens.oneOf,
    ).toHaveLength(2);
    expect(generation.properties.parameters.properties.seed).toBeDefined();
  });
});

describe("parameter catalog request continuity", () => {
  test("loads profiles relative to main config and captures each request's immutable catalog", () => {
    const target = fixture();
    const profilesDirectory = join(
      target.directory,
      "model-parameter-profiles",
    );
    mkdirSync(profilesDirectory);
    const writeLocal = (temperature: number) =>
      writeFileSync(
        join(profilesDirectory, "custom.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "custom",
          match: [{ kind: "exact", pattern: "model" }],
          defaults: { temperature },
        }),
      );
    writeLocal(0.2);
    const config = {
      models: {
        providers: { local: { type: "llamacpp" } },
        profiles: { custom: { provider: "local", model: "model" } },
      },
    };
    const built = buildRuntimeModelConfiguration(config, {
      mainConfigPath: target.mainConfigPath,
    });
    const runnerConfig = {
      models: { defaults: { profileId: "custom", steps: {} } },
      context: { outputReserveTokens: 1024, safetyReserveTokens: 256, attachmentReserveTokens: 128 },
    } as Parameters<typeof createRequestModelPolicy>[0]["runnerConfig"];
    const requestPolicy = createRequestModelPolicy({
      platformPolicy: built.modelPolicy,
      runnerConfig,
    });
    writeLocal(0.8);
    const refreshed = buildRuntimeModelConfiguration(config, {
      mainConfigPath: target.mainConfigPath,
    });
    expect(
      requestPolicy.parameterProfiles?.profiles.find(
        (profile) => profile.id === "custom",
      )?.defaults?.temperature,
    ).toBe(0.2);
    expect(
      refreshed.modelPolicy?.parameterProfiles?.profiles.find(
        (profile) => profile.id === "custom",
      )?.defaults?.temperature,
    ).toBe(0.8);
    expect(requestPolicy.parameterProfiles).toBe(
      built.modelPolicy?.parameterProfiles,
    );
    expect(Object.isFrozen(requestPolicy.parameterProfiles)).toBe(true);
  });

  test("linked model merges preserve canonical controls and collision warnings in calibrations", () => {
    const target = fixture();
    writeFileSync(
      join(target.directory, "model.json"),
      JSON.stringify({
        model: "model",
        contextWindowTokens: 4096,
        generation: { parameters: { top_k: { mode: "value", value: 0 } } },
        calibration: {
          response: {
            generation: { topP: 0.4, parameters: { top_p: { mode: "omit" } } },
          },
        },
      }),
    );
    const built = buildRuntimeModelConfiguration(
      {
        models: {
          profiles: {
            local: {
              configRef: "model.json",
              generation: {
                parameters: {
                  top_k: { mode: "inherit" },
                  seed: { mode: "value", value: 0 },
                },
              },
            },
          },
        },
      },
      { mainConfigPath: target.mainConfigPath },
    );
    const profile = built.modelPolicy?.profiles?.local;
    expect(profile?.generation?.parameters).toEqual({
      top_k: { mode: "value", value: 0 },
      seed: { mode: "value", value: 0 },
    });
    expect(
      profile?.calibration?.response.generation?.parameterDiagnostics?.[0].key,
    ).toBe("top_p");
  });
});
