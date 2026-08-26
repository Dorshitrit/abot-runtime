import { describe, expect, test } from "vitest";

import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { resolveModelSelection } from "../model/model-selection.js";

function createModelPolicy(
  overrides: Partial<ModelGatewayPolicyConfig> = {},
): ModelGatewayPolicyConfig {
  return {
    profiles: {
      gemma: { model: "gemma:test" },
      luna: {
        model: "luna:test",
        calibration: {
          "supervisor.decision": {
            profileId: "gemma",
          },
        },
      },
    },
    defaults: {
      profileId: "gemma",
    },
    ...overrides,
  };
}

describe("request execution policy selection", () => {
  test("defaults to the Supervisor-Worker policy when a profile omits execution metadata", () => {
    const selection = resolveModelSelection({
      agentMode: "reasoning",
      modelPreference: undefined,
      modelPolicy: createModelPolicy(),
    });

    expect(selection.execution).toEqual({
      policy: "supervisor-worker-v1",
      primaryProfileId: "gemma",
      source: "default",
    });
    expect(Object.isFrozen(selection.execution)).toBe(true);
  });

  test.each(["main", "all"] as const)(
    "uses the preferred root profile and its opt-in policy for %s scope without requiring a model step",
    (scope) => {
      const selection = resolveModelSelection({
        agentMode: "reasoning",
        modelPreference: { profileId: "luna", scope },
        modelPolicy: createModelPolicy(),
        modelExecutionPolicies: {
          luna: { policy: "execution-agent-v1" },
        },
      });

      expect(selection.execution).toEqual({
        policy: "execution-agent-v1",
        primaryProfileId: "luna",
        source: "model_profile",
      });
    },
  );

  test("resolves an invocation-profile alias to its canonical base profile", () => {
    const selection = resolveModelSelection({
      agentMode: "reasoning",
      modelPreference: { profileId: "luna-alias", scope: "all" },
      modelPolicy: createModelPolicy({
        invocationProfiles: {
          "luna-alias": { profileId: "luna" },
        },
      }),
      modelExecutionPolicies: {
        luna: { policy: "execution-agent-v1" },
      },
    });

    expect(selection.execution.primaryProfileId).toBe("luna");
    expect(selection.execution.policy).toBe("execution-agent-v1");
    expect(selection.execution.source).toBe("model_profile");
  });

  test("honors configured override precedence before selecting execution policy", () => {
    const selection = resolveModelSelection({
      agentMode: "reasoning",
      modelPreference: { profileId: "luna", scope: "all" },
      modelPolicy: createModelPolicy({
        defaults: {
          profileId: "gemma",
          overrideClientPreference: true,
        },
      }),
      modelExecutionPolicies: {
        gemma: { policy: "supervisor-worker-v1" },
      },
    });

    expect(selection.execution).toEqual({
      policy: "supervisor-worker-v1",
      primaryProfileId: "gemma",
      source: "model_profile",
    });
  });

  test("ignores an unknown preference and uses the configured primary profile", () => {
    const selection = resolveModelSelection({
      agentMode: "reasoning",
      modelPreference: { profileId: "missing", scope: "all" },
      modelPolicy: createModelPolicy(),
      modelExecutionPolicies: {
        gemma: { policy: "supervisor-worker-v1" },
      },
    });

    expect(selection.execution.primaryProfileId).toBe("gemma");
    expect(selection.execution.source).toBe("model_profile");
  });

  test("does not let a step calibration redirect the request execution policy", () => {
    const selection = resolveModelSelection({
      agentMode: "reasoning",
      modelPreference: { profileId: "luna", scope: "all" },
      modelPolicy: createModelPolicy(),
      modelExecutionPolicies: {
        luna: { policy: "execution-agent-v1" },
      },
    });

    expect(selection.execution.primaryProfileId).toBe("luna");
    expect(selection.execution.policy).toBe("execution-agent-v1");
  });
});
