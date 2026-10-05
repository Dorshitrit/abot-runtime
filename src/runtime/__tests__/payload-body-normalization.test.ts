import { describe, expect, it } from "vitest";
import { normalizePayloadBody } from "../orchestration/worker-capabilities/payload-body-normalization.js";
import { normalizePayloadAuthoringResult } from "../adapters/registered-tool-worker-capabilities/payload-authoring-result.js";

const format = {
  type: "object", additionalProperties: false,
  properties: { label: { type: "string" }, count: { type: "integer" } },
  required: ["label", "count"],
};

const repeatedMembers = [
  '{"key":1,"key":2}',
  '{"key":1,"key":1}',
  '{"":1,"":2}',
  '{"__proto__":1,"__proto__":2}',
  '{"commands":[{"as":"first","mutation":{"kind":"add"},"as":"second","mutation":{"kind":"update"}}]}',
  '{"outer":[{"nested":{"key":1,"key":2}}]}',
  String.raw`{"a":1,"\u0061":2}`,
  String.raw`{"a\"b":1,"a\u0022b":2}`,
  String.raw`{"😀":1,"\ud83d\ude00":2}`,
];

describe("declared payload JSON member integrity", () => {
  it.each(repeatedMembers)("rejects repeated member identity before normalization: %s", (body) => {
    expect(normalizePayloadBody(body, "json")).toEqual({
      ok: false, issue: { path: "output", message: expect.stringContaining("unique") },
    });
  });

  it.each([
    '{"outer":{"key":1},"key":2}',
    '[{"key":1},{"key":2}]',
    '{"one":{"key":1},"two":{"key":2}}',
    String.raw`{"text":"{\"key\":1,\"key\":2}","quoted":"a\\\"b"}`,
    '{"01":1,"1":2,"__proto__":{"value":3}}',
    'null', 'true', '12', '"value"', '[]', '{}',
  ])("preserves canonical values for valid independent members: %s", (body) => {
    expect(normalizePayloadBody(body, "json")).toEqual({
      ok: true, body: JSON.stringify(JSON.parse(body)),
    });
  });

  it.each(['{"key":', '{"key":"unterminated}', '{"key":1,}', '{key:1}', String.raw`{"\uZZZZ":1}`])(
    "keeps malformed JSON on the existing invalid-output path: %s", (body) => {
      expect(normalizePayloadBody(body, "json")).toMatchObject({ ok: false, issue: { path: "output" } });
    },
  );

  it("retains schema validation and normalization for valid JSON", () => {
    expect(normalizePayloadBody(' { "label": "result", "count": 2 } ', format))
      .toEqual({ ok: true, body: '{"label":"result","count":2}' });
    expect(normalizePayloadBody('{"label":"result","count":"two"}', format))
      .toMatchObject({ ok: false, issue: { path: "output/count" } });
  });

  it("does not echo long member names or payload values into the diagnostic", () => {
    const secret = "private-member-".repeat(1_000);
    const body = `{${JSON.stringify(secret)}:1,${JSON.stringify(secret)}:2}`;
    const result = normalizePayloadBody(body, "json");
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result).length).toBeLessThan(150);
  });

  it.each(repeatedMembers)("preserves unstructured payload text verbatim: %s", (body) => {
    const exact = `  ${body}\n`;
    expect(normalizePayloadBody(exact, undefined)).toEqual({ ok: true, body: exact });
  });

  it("enforces the same guard on injected payload-author results", () => {
    expect(normalizePayloadAuthoringResult({ status: "authored", body: repeatedMembers[4] }, 0, 4_096, "json"))
      .toEqual({ status: "failed", code: "payload_model_output_invalid" });
    expect(normalizePayloadAuthoringResult({ status: "authored", body: repeatedMembers[4] }, 0, 4_096))
      .toEqual({ status: "authored", body: repeatedMembers[4] });
  });
});
