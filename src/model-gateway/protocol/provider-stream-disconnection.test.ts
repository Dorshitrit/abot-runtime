import { expect, test } from "vitest";
import { ModelGatewayInvocationError } from "../client/invocation-error.js";
import { toolMediaSafeError } from "../observability/tool-media-privacy.js";
import {
  isProviderStreamDisconnectionError, PROVIDER_STREAM_DISCONNECTION,
  ProviderStreamDisconnectionError, providerStreamDisconnectionCause,
} from "./provider-stream-disconnection.js";

test("a gateway-owned disconnection retains provenance through bounded typed causes", () => {
  const gateway = new ModelGatewayInvocationError("stream", "diagnostic",
    providerStreamDisconnectionCause(PROVIDER_STREAM_DISCONNECTION));
  expect(isProviderStreamDisconnectionError(new Error("runtime wrapper", { cause: gateway }))).toBe(true);
  expect(gateway.message).toBe("diagnostic");
});

test.each([
  "model_provider_stream_disconnected",
  new Error("model_provider_stream_disconnected"),
  Object.assign(new Error("lookalike"), { name: "ProviderStreamDisconnectionError", code: "model_provider_stream_disconnected" }),
  { cause: new ProviderStreamDisconnectionError() },
  new Error("lookalike", { cause: { code: "model_provider_stream_disconnected" } }),
])("untrusted lookalikes cannot establish disconnection provenance: %j", (error) => {
  expect(isProviderStreamDisconnectionError(error)).toBe(false);
});

test("unknown versions, cyclic and unbounded chains fail closed", () => {
  expect(providerStreamDisconnectionCause("provider_stream_disconnection_v2")).toBeUndefined();
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  expect(isProviderStreamDisconnectionError(cycle)).toBe(false);
  let deep: Error = new ProviderStreamDisconnectionError();
  for (let depth = 0; depth < 8; depth += 1) deep = new Error("wrapper", { cause: deep });
  expect(isProviderStreamDisconnectionError(deep)).toBe(false);
});

test("tool-media sanitization retains only content-free disconnection evidence", () => {
  const original = new Error("PRIVATE", { cause: new ProviderStreamDisconnectionError() });
  const safe = toolMediaSafeError(original, { kind: "tool_image_v1", id: "PRIVATE" });
  expect(isProviderStreamDisconnectionError(safe)).toBe(true);
  expect(String(safe)).not.toContain("PRIVATE");
  expect((safe as Error).cause).toBeInstanceOf(ProviderStreamDisconnectionError);
  expect((safe as Error).cause).not.toHaveProperty("cause");
});
