import { expect, test, vi } from "vitest";
import type { ToolNormalInvocationOperation } from "../../capabilities/tool-types.js";
import { validateInvocationPayload } from "../adapters/registered-tool-normal-invocations/execution/call-binding.js";

const operation: ToolNormalInvocationOperation = {
  operationId: "write", summary: "Write content", input: { type: "object", properties: {}, required: [], additionalProperties: false },
  effect: "mutating", approval: "request_policy",
  payload: { kind: "raw_text", param: "payload", maxBytes: 4, minBytes: 1, instructions: "Write content" },
};

test("tools without an envelope adapter retain raw UTF-8 byte limits", () => {
  expect(validateInvocationPayload(operation, undefined, { tool: "write", params: { payload: "🙂" } })).toBeUndefined();
  expect(validateInvocationPayload(operation, {}, { tool: "write", params: { payload: "🙂x" } })).toBe("payload exceeds 4 bytes");
  expect(validateInvocationPayload(operation, {}, { tool: "write", params: { payload: "" } })).toBe("payload is smaller than 1 bytes");
});

test("unwrapped content still enforces minimum and maximum bytes", () => {
  const call = { tool: "write", params: { payload: '{"body":"🙂"}' } };
  expect(validateInvocationPayload(operation, { payloadContent: () => "🙂" }, call)).toBeUndefined();
  expect(validateInvocationPayload(operation, { payloadContent: () => "🙂x" }, call)).toBe("payload exceeds 4 bytes");
  expect(validateInvocationPayload(operation, { payloadContent: () => "" }, call)).toBe("payload is smaller than 1 bytes");
  expect(validateInvocationPayload(operation, { payloadContent: () => { throw new Error("bad_binding"); } }, call))
    .toBe("payload content could not be verified");
});

test("non-string and absent payloads cannot bypass validation through an adapter", () => {
  const payloadContent = vi.fn(() => "ok");
  for (const payload of [undefined, {}, 4]) {
    expect(validateInvocationPayload(operation, { payloadContent }, { tool: "write", params: { payload } }))
      .toBe("payload must be raw text");
  }
  expect(payloadContent).not.toHaveBeenCalled();
});
