import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRegisteredToolPayloadTargetContext,
  type RegisteredToolPayloadStage, type RegisteredToolStagedPayloadPlan,
} from "../adapters/registered-tool-payload-plan.js";
import { shouldPreserveFullBoundedTargetContext } from "../adapters/registered-tool-worker-capabilities/payload-target-context-policy.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) };
});
const source = "first\r\nsecond\r\nthird\r\nfourth\r\nfifth\r\nsixth\r\n";
const selector: RegisteredToolPayloadStage = {
  outputParam: "selection", instructions: "Select current lines.", minBytes: 0, maxBytes: 4096,
  contextScope: "target_only", targetContext: "full_numbered",
  responseFormat: "json", targetLineBoundProperties: ["start_line", "end_line"], includeMaterializedParams: [],
};
const body: RegisteredToolPayloadStage = {
  outputParam: "content", instructions: "Replace selected lines.", minBytes: 1, maxBytes: 4096,
  contextScope: "target_with_artifacts", targetContext: "bounded",
  targetLineBoundProperties: [], includeMaterializedParams: ["selection"],
};
const plan: RegisteredToolStagedPayloadPlan = {
  publicInput: { type: "object", properties: {}, required: [], additionalProperties: false },
  payloadParams: ["selection", "content"], outputParam: "content", payloadMinBytes: 1,
  targetParam: "path", groundingWindow: 1, stages: [selector, body],
};
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "registered-full-target-"));
  await fs.writeFile(join(root, "target.txt"), source);
  await fs.writeFile(join(root, "other.txt"), "unselected source");
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

test("full target preserves exact bytes and selected bounds, with one selected-file read", async () => {
  const result = await resolve(true);
  expect(result).toEqual({ targetParam: "path", targetPath: "target.txt", presentation: "bounded",
    content: source, sourceRange: { contextStartLine: 1, contextEndLine: 7,
      writableStartLine: 3, writableEndLine: 4, totalLines: 7 } });
  expect(fs.readFile).toHaveBeenCalledExactlyOnceWith(join(root, "target.txt"), "utf8");
  expect(fs.stat).toHaveBeenCalledExactlyOnceWith(join(root, "target.txt"));
});

test.each([false, undefined])("option %s retains the exact bounded projection", async option => {
  expect(await resolve(option)).toEqual({ targetParam: "path", targetPath: "target.txt", presentation: "bounded",
    content: "second\nthird\nfourth\nfifth", sourceRange: { contextStartLine: 2, contextEndLine: 5,
      writableStartLine: 3, writableEndLine: 4, totalLines: 7 } });
});

test("the body resolves current target contents rather than retaining the selector snapshot", async () => {
  const before = await resolveRegisteredToolPayloadTargetContext({ ...input(), stage: selector });
  expect(before?.content).toContain("3 | third");
  const changed = source.replace("third", "current-third");
  await fs.writeFile(join(root, "target.txt"), changed);
  expect((await resolve(true))?.content).toBe(changed);
});

test.each([false, true])("missing and now-out-of-range targets remain unavailable, full=%s", async option => {
  await fs.writeFile(join(root, "target.txt"), "short\nnow");
  expect(await resolve(option)).toBeUndefined();
  await fs.unlink(join(root, "target.txt"));
  expect(await resolve(option)).toBeUndefined();
});

test.each([undefined, "not-json", "[]", '{"start_line":0,"end_line":4}',
  '{"start_line":3,"end_line":999}', '{"start_line":"3","end_line":4}'])
("invalid prior range remains unavailable: %s", async selection => {
  expect(await resolveRegisteredToolPayloadTargetContext({ ...input(),
    materializedParams: selection === undefined ? {} : { selection },
    preserveFullBoundedTargetContext: true })).toBeUndefined();
});

test("the option does not change full-numbered selectors or a stage without target context", async () => {
  const selected = await resolveRegisteredToolPayloadTargetContext({ ...input(), stage: selector });
  expect(await resolveRegisteredToolPayloadTargetContext({ ...input(), stage: selector,
    preserveFullBoundedTargetContext: true })).toEqual(selected);
  const writeStage = { ...body, targetContext: undefined };
  vi.mocked(fs.readFile).mockClear();
  expect(await resolveRegisteredToolPayloadTargetContext({ ...input(), stage: writeStage,
    preserveFullBoundedTargetContext: true })).toBeUndefined();
  expect(fs.readFile).not.toHaveBeenCalled();
});

test("only an opted-in Worker final raw bounded stage widens its target", () => {
  const params = { preserveFullBoundedTargetContext: true, call: { roleId: "worker" }, plan };
  expect(shouldPreserveFullBoundedTargetContext(params, body)).toBe(true);
  expect(shouldPreserveFullBoundedTargetContext(params, selector)).toBe(false);
  for (const roleId of ["supervisor", "planner", "reviewer"]) {
    expect(shouldPreserveFullBoundedTargetContext({ ...params, call: { roleId } }, body)).toBe(false);
  }
  for (const preserveFullBoundedTargetContext of [false, undefined]) {
    expect(shouldPreserveFullBoundedTargetContext({ ...params, preserveFullBoundedTargetContext }, body)).toBe(false);
  }
  for (const stage of [{ ...body, responseFormat: "json" as const }, { ...body, targetContext: "full" as const }]) {
    expect(shouldPreserveFullBoundedTargetContext({ ...params, plan: { ...plan, stages: [selector, stage] } }, stage)).toBe(false);
  }
  expect(shouldPreserveFullBoundedTargetContext({ ...params, plan: { ...plan, stages: [body] } }, body)).toBe(false);
});

function input() {
  return { plan, stage: body, controls: { path: "target.txt" },
    sharedState: { runtimePaths: { rootDir: root, agentWorkDir: root } },
    materializedParams: { selection: '{"placement":"replace","start_line":3,"end_line":4}' } };
}
function resolve(preserveFullBoundedTargetContext?: boolean) {
  return resolveRegisteredToolPayloadTargetContext({ ...input(), preserveFullBoundedTargetContext });
}
