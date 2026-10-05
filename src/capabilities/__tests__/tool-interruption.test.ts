import { expect, test } from "vitest";
import { failureResult } from "../../plugin-sdk/results.js";
import { executeToolCall } from "../tool-executor.js";
import { hasToolAbortReceipt } from "../tool-interruption.js";

test("preserves adapter cancellation provenance and the original error code", async () => {
  const receipt = failureResult({ errorCode: "adapter_request_cancelled", message: "Caller stopped",
    interruption: "aborted" });
  const result = await executeToolCall({ tool: "sample", params: {} }, {
    implementations: { sample: async () => receipt },
  });
  expect(result).toMatchObject({ ok: false, errorCode: "adapter_request_cancelled", interruption: "aborted" });
  expect(hasToolAbortReceipt(result)).toBe(true);
});

test.each([
  { ok: false, errorCode: "request_aborted", expected: true },
  { ok: false, errorCode: "arbitrary_aborted", expected: false },
  { ok: false, errorCode: "upstream_failed", expected: false },
  { ok: true, errorCode: "request_aborted", expected: false },
])("abort classification uses provenance, not error suffixes: $errorCode/$ok", ({ expected, ...result }) => {
  expect(hasToolAbortReceipt(result)).toBe(expected);
});

test("does not carry an interruption marker on successful output", async () => {
  const result = await executeToolCall({ tool: "sample", params: {} }, {
    implementations: { sample: async () => ({ ok: true, output: "Finished", producedNewInformation: true,
      interruption: "aborted" }) },
  });
  expect(result).not.toHaveProperty("interruption");
  expect(hasToolAbortReceipt(result)).toBe(false);
});
