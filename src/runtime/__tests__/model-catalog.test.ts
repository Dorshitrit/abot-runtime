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
          executionPolicy: "supervisor-worker-v1",
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

  test.each([false, true])(
    "projects effective execution policy with client preference override %s without exposing plugin restrictions",
    (overrideClientPreference) => {
      const catalog = projectRuntimeModelCatalog(
        policy({
          profiles: {
            primary: { provider: "local", model: "primary:model" },
            selected: { provider: "local", model: "selected:model" },
          },
          defaults: { profileId: "primary", overrideClientPreference },
        }),
        {
          primary: { plugins: { deny: ["private-plugin-restriction"] } },
          selected: { policy: "execution-agent-v1" },
        },
      );
      expect(catalog.profiles.map(({ id, executionPolicy }) => ({ id, executionPolicy }))).toEqual([
        { id: "primary", executionPolicy: "supervisor-worker-v1" },
        { id: "selected", executionPolicy: overrideClientPreference ? "supervisor-worker-v1" : "execution-agent-v1" },
      ]);
      expect(JSON.stringify(catalog)).not.toContain("private-plugin-restriction");
      expect(catalog.profiles.every((profile) => !("plugins" in profile))).toBe(true);
    },
  );

  test("execution policy belongs to the selected base profile despite step calibration", () => {
    const catalog = projectRuntimeModelCatalog(
      policy({
        profiles: {
          primary: { provider: "local", model: "primary:model" },
          selected: {
            provider: "local", model: "selected:model",
            calibration: { "worker.decision": { profileId: "primary" } },
          },
        },
        defaults: { profileId: "primary", steps: { "supervisor.decision": "primary" } },
      }),
      { selected: { policy: "execution-agent-v1" } },
    );
    expect(catalog.profiles.find((profile) => profile.id === "selected")).toMatchObject({
      model: "selected:model", executionPolicy: "execution-agent-v1",
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
