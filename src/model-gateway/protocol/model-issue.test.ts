import { expect, test, vi } from "vitest";
import { decodeModelIssues, encodeModelIssues, readModelIssue, type ModelIssueDiagnostic } from "./model-issue.js";
import { ClientModelIssues } from "../client/model-issues.js";
import { modelIssueObserver } from "../../runtime/model/model-issue-event.js";
import { ModelGatewayInvocationError } from "../client/invocation-error.js";
import { readSourceIssueId } from "../../shared/source-issue.js";

const issue: ModelIssueDiagnostic = { issueId: "internal-id", occurredAt: 42,
  code: "future_adapter_code", profileId: "profile", provider: "future-provider",
  model: "arbitrary-model", operation: "chat", outcome: "pending" };

test("wire allowlist drops raw diagnostics and rejects malformed internal identity", () => {
  const safe = readModelIssue({ ...issue, message: "secret", body: { token: "secret" } });
  expect(safe).toEqual(issue);
  expect(decodeModelIssues(encodeModelIssues([safe!])!)).toEqual([issue]);
  for (const invalid of [
    { issueId: "unsafe\nidentity" }, { occurredAt: NaN }, { outcome: "success" },
    { requestedValue: "private provider response with spaces" }, { operation: "unknown" },
  ]) expect(readModelIssue({ ...issue, ...invalid })).toBeUndefined();
  expect(decodeModelIssues("not-json")).toEqual([]);
});

test.each([
  ["internal spaces", "OpenAI Primary"],
  ["Hebrew", "ספק ראשי"],
  ["CJK", "主要 供應者"],
  ["long ASCII", "a".repeat(81)],
  ["maximum Unicode", "字".repeat(160)],
])("configured provider identity survives diagnostic round-trip: %s", (_label, providerId) => {
  const diagnostic = { ...issue, providerId };
  expect(readModelIssue(diagnostic)).toEqual(diagnostic);
  expect(decodeModelIssues(encodeModelIssues([diagnostic])!)).toEqual([diagnostic]);
});

test.each([
  ["empty", ""], ["over limit", "a".repeat(161)],
  ["newline", "provider\nname"], ["NUL", "provider\u0000name"],
  ["DEL", "provider\u007fname"], ["number", 42], ["null", null],
  ["unpaired surrogate", "provider\ud800name"],
])("malformed provider identities remain excluded: %s", (_label, providerId) => {
  expect(readModelIssue({ ...issue, providerId })).toBeUndefined();
});

test.each(["parameter", "requestedValue", "recovery"])("provider text does not relax diagnostic code validation: %s", (key) => {
  expect(readModelIssue({ ...issue, providerId: "ספק ראשי", [key]: "untrusted text" })).toBeUndefined();
});

test("pending and duplicate final metadata count once with immutable origin", () => {
  const observe = vi.fn();
  const client = new ClientModelIssues(observe);
  client.observe(issue);
  client.observe({ ...issue, occurredAt: 99, model: "wrong", outcome: "recovered" });
  client.observe({ ...issue, outcome: "failed" });
  client.finish("recovered");
  client.finish("failed");
  expect(observe).toHaveBeenCalledExactlyOnceWith({ ...issue, outcome: "recovered" });
});

test("bounded metadata and passive observer cannot change execution failure identity", () => {
  const observer = vi.fn(() => { throw new Error("observer failed"); });
  const client = new ClientModelIssues(observer);
  for (let index = 0; index < 100; index++) client.observe({ ...issue, issueId: `issue-${index}` });
  const failure = new ModelGatewayInvocationError("stream", "original");
  expect(() => client.finish("failed", failure)).not.toThrow();
  expect(observer).toHaveBeenCalledTimes(4);
  expect(readSourceIssueId(new Error("wrapped", { cause: failure }))).toBe("issue-0");
});

test("runtime routes facts through the existing event sink with exact invocation binding", () => {
  const onEvent = vi.fn();
  modelIssueObserver({ requestId: "request", invocationId: "invocation", modelStep: "step", onEvent })({ ...issue, outcome: "recovered" });
  expect(onEvent).toHaveBeenCalledExactlyOnceWith("model.issue.observed", {
    ...issue, outcome: "recovered", requestId: "request", invocationId: "invocation", modelStep: "step",
  });
});
