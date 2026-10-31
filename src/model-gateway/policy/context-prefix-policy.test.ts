import { describe, expect, test } from "vitest";
import type { ModelGatewayPolicyConfig, ModelGatewayRequest } from "../types.js";
import { shouldUseStableExecutionContextPrefix } from "./context-prefix-policy.js";

const policy: ModelGatewayPolicyConfig = {
  providers: {
    api: { type: "openai" }, local: { type: "ollama" },
    desktop: { type: "openai-chatgpt" }, native: { type: "llamacpp" },
  },
  profiles: {
    remote: { provider: "api", model: "model", contextWindowTokens: 32000, options: { prompt_cache_options: { mode: "implicit" } } },
    local: { provider: "local", model: "model", contextWindowTokens: 32000 },
    desktop: { provider: "desktop", model: "model", contextWindowTokens: 32000 },
    native: { provider: "native", model: "model", contextWindowTokens: 32000 },
  },
  defaults: { profileId: "remote" },
};
const request: ModelGatewayRequest = {
  agentMode: "reasoning", modelStep: "execution.decision", modelPolicy: policy,
};

describe("provider-owned stable execution context prefix policy", () => {
  test("uses the resolved API provider, independent of profile or model names", () => {
    expect(shouldUseStableExecutionContextPrefix(request)).toBe(true);
  });
  test.each([undefined, {}, { prompt_cache_options: { mode: "explicit" } }, { prompt_cache_options: { mode: "implicit", ttl: "12h" } }])(
    "requires the exact supported opt-in: %j", (options) => {
      expect(shouldUseStableExecutionContextPrefix({ ...request, modelPolicy: {
        ...policy, profiles: { ...policy.profiles, remote: { ...policy.profiles!.remote!, options } },
      } })).toBe(false);
    },
  );
  test.each(["local", "desktop", "native"])("preserves %s provider ordering", (profileId) => {
    expect(shouldUseStableExecutionContextPrefix({
      ...request, modelPreference: { profileId, scope: "all" },
    })).toBe(false);
  });
  test.each(["execution.response", "supervisor.decision", "worker.decision", "capability.controls", "context.compact"])(
    "preserves the %s model step", (modelStep) => {
      expect(shouldUseStableExecutionContextPrefix({ ...request, modelStep })).toBe(false);
    },
  );
  test("honors configured model-step selection", () => {
    expect(shouldUseStableExecutionContextPrefix({ ...request, modelPolicy: {
      ...policy, defaults: { profileId: "remote", steps: { "execution.decision": "local" } },
    } })).toBe(false);
  });
  test("honors configuration that overrides the client preference", () => {
    expect(shouldUseStableExecutionContextPrefix({ ...request,
      modelPreference: { profileId: "remote", scope: "all" }, modelPolicy: {
        ...policy, defaults: { profileId: "local", overrideClientPreference: true },
      },
    })).toBe(false);
  });
  test("honors step calibration that selects another provider", () => {
    expect(shouldUseStableExecutionContextPrefix({ ...request, modelPolicy: {
      ...policy, profiles: { ...policy.profiles,
        remote: { ...policy.profiles!.remote!, calibration: { decision: { profileId: "local" } } },
      }, defaults: { profileId: "remote", steps: { "execution.decision": "decision" } },
    } })).toBe(false);
  });
});
