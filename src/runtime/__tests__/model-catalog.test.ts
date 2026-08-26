import { describe, expect, test } from "vitest";

import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { projectRuntimeModelCatalog } from "../model/model-catalog.js";

function policy(
  overrides: Partial<ModelGatewayPolicyConfig> = {},
): ModelGatewayPolicyConfig {
  return {
    providers: {
      local: { type: "ollama" },
    },
    profiles: {
      primary: {
        label: "Primary model",
        provider: "local",
        model: "primary:model",
        supportsThinking: true,
        capabilities: {
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
        },
      },
    },
    defaults: {
      profileId: "primary",
    },
    ...overrides,
  };
}

describe("projectRuntimeModelCatalog", () => {
  test("projects only explicitly configured providers and profiles", () => {
    expect(projectRuntimeModelCatalog(policy())).toEqual({
      defaultProfileId: "primary",
      profiles: [
        {
          id: "primary",
          label: "Primary model",
          providerId: "local",
          provider: "ollama",
          model: "primary:model",
          supportsThinking: true,
          capabilities: {
            inputModalities: ["text", "image"],
            outputModalities: ["text"],
          },
          supportsImageInput: true,
        },
      ],
    });
  });

  test("rejects a profile without an explicit provider", () => {
    expect(() =>
      projectRuntimeModelCatalog(
        policy({
          profiles: {
            primary: {
              model: "primary:model",
            },
          },
        }),
      ),
    ).toThrow(
      "Invalid runtime model catalog: models.profiles.primary.provider must be configured",
    );
  });

  test("rejects a profile that references an unknown provider", () => {
    expect(() =>
      projectRuntimeModelCatalog(
        policy({
          profiles: {
            primary: {
              provider: "missing",
              model: "primary:model",
            },
          },
        }),
      ),
    ).toThrow(
      "Invalid runtime model catalog: models.profiles.primary.provider references unknown provider missing",
    );
  });

  test("rejects a missing default profile", () => {
    expect(() =>
      projectRuntimeModelCatalog(
        policy({
          defaults: {},
        }),
      ),
    ).toThrow(
      "Invalid runtime model catalog: models.defaults.profileId must be configured",
    );
  });

  test("rejects an unknown default profile", () => {
    expect(() =>
      projectRuntimeModelCatalog(
        policy({
          defaults: { profileId: "missing" },
        }),
      ),
    ).toThrow(
      "Invalid runtime model catalog: models.defaults.profileId references unknown model profile missing",
    );
  });
});
