import { describe, expect, test } from "vitest";

import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { validateEffectiveRuntimeModelConfig } from "../config/effective-model-config-validation.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import { RuntimeConfigValidationError } from "../config/validation.js";

function runnerConfig(params: {
  profileId: string;
  steps?: Record<string, string>;
}): RequestRunnerConfig {
  return {
    models: {
      defaults: {
        profileId: params.profileId,
        steps: params.steps ?? {},
      },
    },
    context: {
      outputReserveTokens: 4_096,
      safetyReserveTokens: 1_200,
      attachmentReserveTokens: 1_024,
    },
    steps: {},
  };
}

function validate(
  modelPolicy: ModelGatewayPolicyConfig | undefined,
  runner: RequestRunnerConfig,
): void {
  validateEffectiveRuntimeModelConfig({
    configPath: "/runtime.config.json",
    modelPolicy,
    runnerConfig: runner,
  });
}

describe("effective runtime model config validation", () => {
  test("accepts configured profiles, invocation profiles, and calibration-slot step mappings", () => {
    expect(() =>
      validate(
        {
          providers: {
            local: { type: "ollama" },
          },
          profiles: {
            primary: {
              provider: "local",
              model: "primary:model",
              contextWindowTokens: 32_768,
              calibration: {
                "decision-slot": {
                  generation: { temperature: 0.1 },
                },
              },
            },
            secondary: {
              provider: "local",
              model: "secondary:model",
              contextWindowTokens: 32_768,
              calibration: {
                "response-slot": {
                  profileId: "primary",
                },
              },
            },
          },
          invocationProfiles: {
            concise: {
              profileId: "secondary",
              generation: { temperature: 0.2 },
            },
          },
          defaults: {
            roles: { worker: "concise" },
            steps: { "supervisor.response": "response-slot" },
          },
        },
        runnerConfig({
          profileId: "primary",
          steps: {
            "supervisor.decision": "decision-slot",
            "worker.result": "concise",
          },
        }),
      ),
    ).not.toThrow();
  });

  test("requires explicit providers and model profiles", () => {
    expect(() => validate(undefined, runnerConfig({ profileId: "missing" })))
      .toThrow(
        expect.objectContaining({
          issues: expect.arrayContaining([
            "models.providers must declare at least one provider",
            "models.profiles must declare at least one model profile",
          ]),
        }),
      );
  });

  test("accepts an implicit identity step target without configured calibration", () => {
    expect(() =>
      validate(
        {
          providers: {
            local: { type: "ollama" },
          },
          profiles: {
            primary: {
              provider: "local",
              model: "primary:model",
              contextWindowTokens: 32_768,
            },
          },
        },
        runnerConfig({
          profileId: "primary",
          steps: {
            "capability.controls": "capability.controls",
          },
        }),
      ),
    ).not.toThrow();
  });

  test("rejects every unresolved provider and model-profile reference", () => {
    let thrown: unknown;
    try {
      validate(
        {
          providers: {
            configured: { type: "ollama" },
          },
          profiles: {
            implicit: {
              model: "implicit:model",
              contextWindowTokens: 32_768,
            },
            broken: {
              provider: "missing-provider",
              model: "broken:model",
              contextWindowTokens: 32_768,
              calibration: {
                redirect: { profileId: "missing-calibration-profile" },
              },
            },
          },
          invocationProfiles: {
            brokenInvocation: { profileId: "missing-invocation-profile" },
          },
          defaults: {
            profileId: "missing-default-profile",
            roles: { worker: "missing-role-target" },
            steps: { "worker.result": "missing-platform-step-target" },
          },
        },
        runnerConfig({
          profileId: "missing-runner-profile",
          steps: {
            "supervisor.decision": "missing-runner-step-target",
          },
        }),
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RuntimeConfigValidationError);
    expect((thrown as RuntimeConfigValidationError).issues).toEqual(
      expect.arrayContaining([
        "models.profiles.implicit.provider must be a non-empty string",
        "models.profiles.broken.provider references unknown provider missing-provider",
        "models.profiles.broken.calibration.redirect.profileId references unknown model profile missing-calibration-profile",
        "models.invocationProfiles.brokenInvocation.profileId references unknown model profile missing-invocation-profile",
        "models.defaults.profileId references unknown model profile missing-default-profile",
        "models.defaults.roles.worker references unknown model or invocation profile missing-role-target",
        "models.defaults.steps.worker.result references unknown model profile, invocation profile, or calibration slot missing-platform-step-target",
        "requestRunner.models.defaults.profileId references unknown model profile missing-runner-profile",
        "requestRunner.models.defaults.steps.supervisor.decision references unknown model profile, invocation profile, or calibration slot missing-runner-step-target",
      ]),
    );
  });
});
