import { describe, expect, test } from "vitest";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { validateEffectiveRuntimeModelConfig } from "../config/effective-model-config-validation.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import { RuntimeConfigValidationError } from "../config/validation.js";

const defaultContext = {
  outputReserveTokens: 4_096,
  safetyReserveTokens: 1_200,
  attachmentReserveTokens: 1_024,
};

function validate(params: {
  tokens: number;
  allocation?: unknown;
  providerType?: string;
  context?: RequestRunnerConfig["context"];
  profileFormatReserve?: number;
  defaultFormatReserve?: number;
}): void {
  const modelPolicy: ModelGatewayPolicyConfig = {
    providers: { local: { type: params.providerType ?? "ollama" } },
    profiles: {
      default: {
        provider: "local",
        model: "configured-model",
        contextWindowTokens: params.tokens,
        ...(params.allocation === undefined
          ? {}
          : { options: { num_ctx: params.allocation } }),
        context: {
          formatTokenAccounting: {
            mode: "estimate",
            fixedOverheadTokens: params.profileFormatReserve ?? 0,
          },
        },
      },
    },
    defaults: {
      context: {
        formatTokenAccounting: {
          mode: "estimate",
          fixedOverheadTokens: params.defaultFormatReserve ?? 0,
        },
      },
    },
  };
  validateEffectiveRuntimeModelConfig({
    configPath: "/private/config.json",
    modelPolicy,
    runnerConfig: {
      models: { defaults: { profileId: "default", steps: {} } },
      context: params.context ?? defaultContext,
      steps: {},
    },
  });
}

function validationFailure(params: Parameters<typeof validate>[0]) {
  try {
    validate(params);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeConfigValidationError);
    return error as RuntimeConfigValidationError;
  }
  throw new Error("Expected context capacity validation to fail");
}

describe("effective model context capacity diagnostics", () => {
  test.each([1, 4_096, 6_319, 6_320])(
    "rejects %i with structured capacity evidence and compatible string issues",
    (tokens) => {
      const failure = validationFailure({ tokens });
      expect(failure.capacityIssues).toEqual([
        {
          profileId: "default",
          declaredTokens: tokens,
          effectiveTokens: tokens,
          reservedTokens: 6_320,
          minimumTokens: 6_321,
        },
      ]);
      expect(failure.issues).toHaveLength(1);
      expect(failure.issues.every((issue) => typeof issue === "string")).toBe(
        true,
      );
      expect(failure.message).toContain(failure.issues[0]);
    },
  );

  test.each([6_321, 8_192, 16_384, 32_768])(
    "accepts %i without altering the reserved-capacity rule",
    (tokens) => {
      expect(() => validate({ tokens })).not.toThrow();
    },
  );

  test.each([
    { profileFormatReserve: 48, defaultFormatReserve: 16 },
    { profileFormatReserve: 16, defaultFormatReserve: 48 },
  ])(
    "uses actual runner reserves and the largest configured format reserve",
    (format) => {
      const params = {
        ...format,
        context: {
          outputReserveTokens: 256,
          safetyReserveTokens: 64,
          attachmentReserveTokens: 32,
        },
      };
      expect(
        validationFailure({ ...params, tokens: 400 }).capacityIssues[0],
      ).toMatchObject({
        reservedTokens: 400,
        minimumTokens: 401,
      });
      expect(() => validate({ ...params, tokens: 401 })).not.toThrow();
    },
  );

  test.each([4_096, 6_320])(
    "reports the configured Ollama allocation %i as the effective ceiling",
    (allocation) => {
      expect(
        validationFailure({ tokens: 32_768, allocation }).capacityIssues[0],
      ).toMatchObject({
        declaredTokens: 32_768,
        allocationTokens: allocation,
        effectiveTokens: allocation,
        reservedTokens: 6_320,
        minimumTokens: 6_321,
      });
    },
  );

  test("does not use a larger allocation to overstate declared capacity", () => {
    expect(
      validationFailure({ tokens: 4_096, allocation: 32_768 })
        .capacityIssues[0],
    ).toMatchObject({
      declaredTokens: 4_096,
      allocationTokens: 32_768,
      effectiveTokens: 4_096,
    });
    expect(() => validate({ tokens: 32_768, allocation: 6_321 })).not.toThrow();
    expect(() =>
      validate({ tokens: 32_768, allocation: 1, providerType: "openai" }),
    ).not.toThrow();
  });

  test.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "keeps malformed declared capacity %s separate from insufficient capacity",
    (tokens) => {
      expect(validationFailure({ tokens }).capacityIssues).toEqual([]);
    },
  );

  test.each([0, -1, 1.5, "8192"])(
    "keeps malformed Ollama allocation %s separate from insufficient capacity",
    (allocation) => {
      expect(
        validationFailure({ tokens: 32_768, allocation }).capacityIssues,
      ).toEqual([]);
    },
  );

  test("keeps other runtime validation errors compatible", () => {
    const failure = new RuntimeConfigValidationError("/private/config.json", [
      "invalid field",
    ]);
    expect(failure.issues).toEqual(["invalid field"]);
    expect(failure.capacityIssues).toEqual([]);
  });
});
