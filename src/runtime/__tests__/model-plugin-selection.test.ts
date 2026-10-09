import { describe, expect, test } from "vitest";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { resolveModelSelection } from "../model/model-selection.js";

const modelPolicy: ModelGatewayPolicyConfig = {
  profiles: {
    primary: { model: "primary:test" },
    preferred: {
      model: "preferred:test",
      calibration: { "worker.decision": { profileId: "primary" } },
    },
  },
  invocationProfiles: { alias: { profileId: "preferred" } },
  defaults: { profileId: "primary", steps: { "worker.decision": "primary" } },
};
const modelExecutionPolicies = {
  primary: { plugins: { deny: ["memory"] } },
  preferred: { plugins: { deny: ["exec"] } },
};

describe("request model plugin restrictions", () => {
  test.each(["main", "all"] as const)(
    "uses the selected request profile for %s scope despite step overrides",
    (scope) => {
      const { execution } = resolveModelSelection({
        agentMode: "reasoning",
        modelPreference: { profileId: "preferred", scope },
        modelPolicy,
        modelExecutionPolicies,
      });
      expect(execution).toEqual({
        policy: "supervisor-worker-v1",
        primaryProfileId: "preferred",
        source: "default",
        plugins: { deny: ["exec"] },
      });
    },
  );

  test.each([undefined, { profileId: "missing" }])(
    "uses configured default when client preference is %j",
    (modelPreference) => {
      const { execution } = resolveModelSelection({
        agentMode: "reasoning",
        modelPreference,
        modelPolicy,
        modelExecutionPolicies,
      });
      expect(execution.primaryProfileId).toBe("primary");
      expect(execution.plugins?.deny).toEqual(["memory"]);
    },
  );

  test("honors configured client-preference override", () => {
    const { execution } = resolveModelSelection({
      agentMode: "reasoning",
      modelPreference: { profileId: "preferred" },
      modelPolicy: {
        ...modelPolicy,
        defaults: { ...modelPolicy.defaults, overrideClientPreference: true },
      },
      modelExecutionPolicies,
    });
    expect(execution.primaryProfileId).toBe("primary");
    expect(execution.plugins?.deny).toEqual(["memory"]);
  });

  test("resolves invocation aliases to base profile restrictions", () => {
    const { execution } = resolveModelSelection({
      agentMode: "reasoning",
      modelPreference: { profileId: "alias" },
      modelPolicy,
      modelExecutionPolicies,
    });
    expect(execution.primaryProfileId).toBe("preferred");
    expect(execution.plugins?.deny).toEqual(["exec"]);
  });

  test("captures a normalized immutable copy without altering another profile", () => {
    const deny = [" memory ", "exec", "memory"];
    const { execution } = resolveModelSelection({
      agentMode: "reasoning",
      modelPreference: { profileId: "preferred" },
      modelPolicy,
      modelExecutionPolicies: {
        primary: modelExecutionPolicies.primary,
        preferred: { policy: "execution-agent-v1", plugins: { deny } },
      },
    });
    deny.push("*");
    expect(execution.plugins?.deny).toEqual(["exec", "memory"]);
    expect(execution.source).toBe("model_profile");
    expect(execution.policy).toBe("execution-agent-v1");
    expect(Object.isFrozen(execution)).toBe(true);
    expect(Object.isFrozen(execution.plugins)).toBe(true);
    expect(Object.isFrozen(execution.plugins?.deny)).toBe(true);
    expect(modelExecutionPolicies.primary.plugins.deny).toEqual(["memory"]);
  });

  test("does not inherit another profile's deny when selected profile is unrestricted", () => {
    const { execution } = resolveModelSelection({
      agentMode: "reasoning",
      modelPreference: { profileId: "preferred" },
      modelPolicy,
      modelExecutionPolicies: { primary: modelExecutionPolicies.primary },
    });
    expect(execution.plugins).toBeUndefined();
    expect(execution.source).toBe("default");
  });
});
