import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage } from "../../model-gateway/types.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import * as targetPolicy from "../request/super-payload-target-policy.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { fullTargetContextFixture, FULL_TARGET_SOURCE, INCIDENTAL_SOURCE } from "./support/full-target-context-fixture.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) };
});

let root: string;
beforeEach(async () => {
  configureDebugLogger({ enabled: false });
  root = await fs.mkdtemp(join(tmpdir(), "full-target-context-"));
});
afterEach(async () => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

test("SUPER transports the complete current selected target once with matching metadata and unchanged edit bounds", async () => {
  const bypass = vi.spyOn(targetPolicy, "preservesFullSuperPayloadTargetContext").mockReturnValue(false);
  const baseline = await fullTargetContextFixture(root, "supervisor-worker-v1");
  expect(await baseline.run()).toMatchObject({ outcome: "succeeded" });
  bypass.mockRestore();
  const actual = await fullTargetContextFixture(root, "supervisor-worker-v1");
  vi.mocked(fs.readFile).mockClear();
  vi.mocked(fs.stat).mockClear();
  expect(await actual.run()).toMatchObject({ outcome: "succeeded" });

  expect(actual.invoke).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(actual.invoke.mock.calls[0]![0]))
    .toBe(JSON.stringify(baseline.invoke.mock.calls[0]![0]));
  expect(actual.execute.mock.calls[0]![0]).toEqual(baseline.execute.mock.calls[0]![0]);
  const body = actual.invoke.mock.calls[1]![0];
  const messages = body.messages as ChatMessage[];
  const targetMessages = messages.filter(message => message.content.startsWith('{"kind":"runtime_payload_target_content_v1"'));
  expect(targetMessages).toHaveLength(1);
  const [header, content] = splitReference(targetMessages[0]!.content);
  expect(content).toBe(FULL_TARGET_SOURCE);
  expect(header.presentation).toBe("bounded");
  expect(header.sourceRange).toEqual({ contextStartLine: 1, contextEndLine: 11,
    writableStartLine: 4, writableEndLine: 5, totalLines: 11 });
  const contextMessage = messages.find(message => message.content.startsWith("Canonical runtime context:\n"))!;
  const canonical = JSON.parse(contextMessage.content.split("\n").slice(1).join("\n"));
  expect(canonical.targetContext).toEqual({
    targetParam: header.targetParam, targetPath: header.targetPath,
    presentation: header.presentation, sourceRange: header.sourceRange,
    contentRef: header.kind,
  });
  expect(canonical.materializedParams.selection)
    .toBe('{"placement":"replace","start_line":4,"end_line":5}');
  const text = messages.map(message => message.content).join("\n");
  expect(text.split(FULL_TARGET_SOURCE)).toHaveLength(2);
  expect(text).not.toContain("1 | original-line-1");
  expect(text).not.toContain(INCIDENTAL_SOURCE);
  expect(text).not.toContain("runtime_payload_related_artifact_content_v1");
  expect(fs.readFile).not.toHaveBeenCalledWith(join(root, "incidental.txt"), expect.anything());
  expect(fs.stat).not.toHaveBeenCalledWith(join(root, "incidental.txt"));
  expect(vi.mocked(fs.readFile).mock.calls.filter(([path]) => path === join(root, "target.txt"))).toHaveLength(2);
});

test.each(["execution-agent-v1", undefined] as const)(
  "%s preserves complete composed provider-request bytes against the disabled option", async policyId => {
    const bypass = vi.spyOn(targetPolicy, "preservesFullSuperPayloadTargetContext").mockReturnValue(false);
    const baseline = await fullTargetContextFixture(root, policyId);
    expect(await baseline.run()).toMatchObject({ outcome: "succeeded" });
    bypass.mockRestore();
    const actual = await fullTargetContextFixture(root, policyId);
    expect(await actual.run()).toMatchObject({ outcome: "succeeded" });
    expect(actual.invoke).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(actual.invoke.mock.calls.map(([input]) => input)))
      .toBe(JSON.stringify(baseline.invoke.mock.calls.map(([input]) => input)));
    expect(actual.execute.mock.calls[0]![0]).toEqual(baseline.execute.mock.calls[0]![0]);
    const messages = actual.invoke.mock.calls[1]![0].messages as ChatMessage[];
    const target = messages.find(message => message.content.startsWith('{"kind":"runtime_payload_target_content_v1"'))!;
    const [header, content] = splitReference(target.content);
    expect(header.sourceRange).toEqual({ contextStartLine: 3, contextEndLine: 6,
      writableStartLine: 4, writableEndLine: 5, totalLines: 11 });
    expect(content).toBe(FULL_TARGET_SOURCE.split(/\r?\n/u).slice(2, 6).join("\n"));
  },
);

test("SUPER single-stage writes retain exact provider requests and do not read the selected path", async () => {
  const bypass = vi.spyOn(targetPolicy, "preservesFullSuperPayloadTargetContext").mockReturnValue(false);
  const baseline = await fullTargetContextFixture(root, "supervisor-worker-v1", false);
  expect(await baseline.run()).toMatchObject({ outcome: "succeeded" });
  bypass.mockRestore();
  const actual = await fullTargetContextFixture(root, "supervisor-worker-v1", false);
  vi.mocked(fs.readFile).mockClear();
  expect(await actual.run()).toMatchObject({ outcome: "succeeded" });
  expect(actual.invoke).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(actual.invoke.mock.calls[0]![0])).toBe(JSON.stringify(baseline.invoke.mock.calls[0]![0]));
  expect(fs.readFile).not.toHaveBeenCalledWith(join(root, "new.txt"), expect.anything());
});

test("only the exact registered SUPER policy opts in", () => {
  const authority = resolveRequestExecutionPolicy("supervisor-worker-v1").authority;
  expect(targetPolicy.preservesFullSuperPayloadTargetContext(authority)).toBe(true);
  expect(targetPolicy.preservesFullSuperPayloadTargetContext(undefined)).toBe(false);
  expect(targetPolicy.preservesFullSuperPayloadTargetContext(
    resolveRequestExecutionPolicy("execution-agent-v1").authority,
  )).toBe(false);
  expect(targetPolicy.preservesFullSuperPayloadTargetContext({ ...authority, definitionHash: "different" })).toBe(false);
});

function splitReference(content: string): [Record<string, unknown>, string] {
  const separator = content.indexOf("\n");
  return [JSON.parse(content.slice(0, separator)), content.slice(separator + 1)];
}
