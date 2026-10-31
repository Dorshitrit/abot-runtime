import { expect, test } from "vitest";
import {
  isProviderContextOverflowError, PROVIDER_CONTEXT_OVERFLOW,
  ProviderContextOverflowError, providerContextOverflowCause,
} from "./provider-context-overflow.js";
import { ModelGatewayInvocationError } from "../client/invocation-error.js";
import { ModelProviderFailure } from "../../runtime/model/provider-failure.js";

test("typed overflow survives the runtime and gateway failure causes", () => {
  const transport = new ModelGatewayInvocationError("http", "original diagnostic",
    providerContextOverflowCause(PROVIDER_CONTEXT_OVERFLOW));
  const failure = new ModelProviderFailure("execution.decision", transport);
  expect(isProviderContextOverflowError(failure)).toBe(true);
  expect(failure.message).toBe("original diagnostic");
});

test.each([
  "model_provider_context_overflow",
  new Error("context_length_exceeded"),
  Object.assign(new Error("lookalike"), { name: "ProviderContextOverflowError", code: "model_provider_context_overflow" }),
  { cause: new ProviderContextOverflowError() },
  new Error("lookalike", { cause: { code: "model_provider_context_overflow" } }),
])("untrusted lookalike does not establish overflow provenance: %j", (error) => {
  expect(isProviderContextOverflowError(error)).toBe(false);
});

test("unknown metadata versions and cyclic causes fail closed", () => {
  expect(providerContextOverflowCause("provider_context_overflow_v2")).toBeUndefined();
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  expect(isProviderContextOverflowError(cycle)).toBe(false);
});
