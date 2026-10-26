import { afterEach, expect, test, vi } from "vitest";
import { projectToolResultEventMetadata } from "../tool-result-event-projection.js";
import { createToolResultJsonReader, isToolResultJsonPath } from "../tool-result-json-projection.js";
import type { ToolExecutionResult, ToolEventResultMetadataProjection } from "../tool-types.js";

afterEach(() => vi.restoreAllMocks());

function result(output: string): ToolExecutionResult {
  return Object.freeze({ ok: true, tool: "lookup", output, producedNewInformation: true,
    data: Object.freeze({ itemCount: 3 }) });
}
const name = (jsonPath: string): ToolEventResultMetadataProjection => ({ path: "output", jsonPath, kind: "preview" });

test("JSON selectors allow bounded own object keys and canonical array indices only", () => {
  for (const path of ["displayName", "sources.0.displayName", "0.name", "sources.255.name", "a.b.c.d"])
    expect(isToolResultJsonPath(path), path).toBe(true);
  for (const path of [undefined, null, 1, "", ".name", "name.", "a..b", "a.b.c.d.e",
    "sources.256.name", "sources.-1.name", "sources.01.name", "sources.1e0.name",
    "sources.*.name", "sources[0].name", "a.__proto__", "prototype", "a.constructor.name"]) {
    expect(isToolResultJsonPath(path), String(path)).toBe(false);
  }
  const read = createToolResultJsonReader('{"sources":[{"displayName":"First"}],"0":{"name":"Object number"}}');
  expect(read("sources.0.displayName")).toBe("First");
  expect(read("sources.1.displayName")).toBeUndefined();
  expect(read("sources.length")).toBeUndefined();
  expect(read("toString")).toBeUndefined();
  expect(read("0.name")).toBeUndefined();
  expect(createToolResultJsonReader('[{"name":"Root array"}]')("0.name")).toBe("Root array");
});

test("a projector parses JSON lazily once while legacy mappings remain unchanged", () => {
  const execution = result('{"displayName":"First","count":0,"complete":false}');
  const parse = vi.spyOn(JSON, "parse");
  expect(projectToolResultEventMetadata(execution, {
    oldPreview: { path: "output", kind: "preview" },
    count: { path: "data.itemCount", kind: "number" },
  })).toEqual({ oldPreview: execution.output, oldPreviewTruncated: false, count: 3 });
  expect(parse).not.toHaveBeenCalled();
  expect(projectToolResultEventMetadata(execution, {
    documentName: name("displayName"),
    count: { path: "output", jsonPath: "count", kind: "number" },
    complete: { path: "output", jsonPath: "complete", kind: "boolean" },
  })).toEqual({ documentName: "First", documentNameTruncated: false, count: 0, complete: false });
  expect(parse).toHaveBeenCalledOnce();
});

test("invalid JSON and byte-oversized output omit only derived JSON metadata", () => {
  for (const output of ["not json", "null", '"scalar"', '{"displayName":"' + "a".repeat(262144) + '"}',
    JSON.stringify({ displayName: "א".repeat(140000) })]) {
    const execution = result(output);
    const before = JSON.stringify(execution);
    const projected = projectToolResultEventMetadata(execution, {
      documentName: name("displayName"), count: { path: "data.itemCount", kind: "number" },
    });
    expect(projected).toEqual({ count: 3 });
    expect(JSON.stringify(execution)).toBe(before);
  }
});

test("JSON selector misuse and wrong value types fail closed without previewing raw output", () => {
  const execution = result('{"displayName":42,"count":"3","complete":"true","constructor":{"name":"Private"}}');
  expect(projectToolResultEventMetadata(execution, {
    documentName: name("displayName"),
    count: { path: "output", jsonPath: "count", kind: "number" },
    complete: { path: "output", jsonPath: "complete", kind: "boolean" },
    unsafe: name("constructor.name"),
    wrongRoot: { path: "data.itemCount", jsonPath: "displayName", kind: "preview" },
  })).toBeUndefined();
});

test("selected names retain existing preview bounds and cannot mutate frozen evidence", () => {
  const execution = result(JSON.stringify({ sources: [
    { displayName: "a".repeat(1199) + "😀tail", content: "PRIVATE_BODY" },
    { displayName: "b".repeat(1500) }, { displayName: "c".repeat(1500) },
  ], path: "/PRIVATE_PATH" }));
  const before = JSON.stringify(execution);
  const projected = projectToolResultEventMetadata(execution, {
    first: name("sources.0.displayName"), second: name("sources.1.displayName"), third: name("sources.2.displayName"),
  })!;
  expect(projected.first).toBe("a".repeat(1199));
  expect(projected).toMatchObject({ firstTruncated: true, secondTruncated: true, thirdTruncated: true });
  expect([projected.first, projected.second, projected.third].join("").length).toBe(2400);
  expect(JSON.stringify(projected)).not.toContain("PRIVATE");
  expect(JSON.stringify(execution)).toBe(before);
});
