import { expect, test } from "vitest";
import {
  createFilePayloadOutputProtocol, FilePayloadAuthorDeclinedError, parseFilePayloadOutput,
} from "../request/execution-file-payload/output.js";
import { FilePayloadToolHandoff } from "../capabilities/file-payload-tool-handoff.js";

test.each(["", "\uFEFFשלום\r\n", "  no final newline  ", "\n\n", "I cannot perform this edit.\n<<<ABORT example>>>"])(
  "RAW file content preserves exact body bytes without a write frame: %j", (body) => {
    const protocol = createFilePayloadOutputProtocol();
    expect(protocol).not.toHaveProperty("writePrefix");
    for (const ending of ["", "\n", "\r\n"]) {
      expect(parseFilePayloadOutput(body + ending, protocol)).toBe(body + ending);
    }
  },
);

test("an explicit decline carries a bounded reason through the existing EA preparation failure path", () => {
  const protocol = createFilePayloadOutputProtocol();
  expect(() => parseFilePayloadOutput(protocol.abortPrefix + "The selected range lacks the function body." + protocol.suffix, protocol))
    .toThrow(FilePayloadAuthorDeclinedError);
  expect(() => parseFilePayloadOutput(protocol.abortPrefix + "Missing source" + protocol.suffix, protocol))
    .toThrow("File author declined: Missing source");
});

test("a tool control frame yields the original decision without file bytes", () => {
  const p = createFilePayloadOutputProtocol();
  const selection = '{"decision":{"action":"invoke_capability","capabilityId":"read_text","selectionControls":{"path":"source.txt"}}}';
  expect(() => parseFilePayloadOutput(p.toolPrefix + selection + p.suffix, p))
    .toThrow(FilePayloadToolHandoff);
});

test.each(["partial", "missing_end", "extra_text", "mixed", "duplicate", "empty_reason", "long_reason", "wrong_boundary", "mixed_raw"])(
  "rejects %s control output without interpreting it as file bytes", (kind) => {
    const p = createFilePayloadOutputProtocol();
    const abort = p.abortPrefix + "missing source" + p.suffix;
    const outputs: Record<string, string> = {
      partial: p.toolPrefix.slice(0, -3),
      missing_end: p.toolPrefix + "candidate", extra_text: abort + "extra",
      mixed: abort + p.toolPrefix + "{}" + p.suffix, duplicate: abort + abort,
      empty_reason: p.abortPrefix + "  " + p.suffix,
      long_reason: p.abortPrefix + "x".repeat(1025) + p.suffix,
      wrong_boundary: createFilePayloadOutputProtocol().toolPrefix + "{}" + p.suffix,
      mixed_raw: "candidate" + abort,
    };
    expect(() => parseFilePayloadOutput(outputs[kind]!, p)).toThrow("payload_model_output_invalid");
  },
);
