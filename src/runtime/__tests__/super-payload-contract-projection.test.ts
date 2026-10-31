import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { WorkerCapabilityPayloadModelRequest } from "../orchestration/worker-capabilities/payload-contracts.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import * as projection from "../request/super-payload-contract-projection.js";
import { fullTargetContextFixture, FULL_TARGET_SOURCE } from "./support/full-target-context-fixture.js";

const superAuthority = resolveRequestExecutionPolicy("supervisor-worker-v1").authority;
const eaAuthority = resolveRequestExecutionPolicy("execution-agent-v1").authority;
const project = projection.projectSuperPayloadContract;
const canonicalPrefix = "Canonical runtime context:\n";
let root: string;
beforeEach(async () => {
  configureDebugLogger({ enabled: false });
  root = await mkdtemp(join(tmpdir(), "payload-contract-projection-"));
});
afterEach(async () => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

test("SUPER promotes the exact captured contract once and only removes its projected duplicate", async () => {
  const bypass = vi.spyOn(projection, "projectSuperPayloadContract")
    .mockImplementation((input, _authority, metadata) => ({ instructions: input.instructions, metadata }));
  const baseline = await fullTargetContextFixture(root, "supervisor-worker-v1");
  await baseline.run();
  bypass.mockRestore();
  const captured: { input: WorkerCapabilityPayloadModelRequest; before: string;
    metadata: Readonly<Record<string, unknown>>; result: ReturnType<typeof project> }[] = [];
  vi.spyOn(projection, "projectSuperPayloadContract").mockImplementation((input, authority, metadata) => {
    const before = JSON.stringify(input);
    const result = project(input, authority, metadata);
    captured.push({ input, before, metadata, result });
    return result;
  });
  const actual = await fullTargetContextFixture(root, "supervisor-worker-v1");
  await actual.run();
  expect(actual.invoke).toHaveBeenCalledTimes(2);
  expect(baseline.invoke).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(actual.invoke.mock.calls[0]![0])).toBe(JSON.stringify(baseline.invoke.mock.calls[0]![0]));
  const before = baseline.invoke.mock.calls[1]![0];
  const after = actual.invoke.mock.calls[1]![0];
  expect(JSON.stringify({ ...after, messages: before.messages })).toBe(JSON.stringify(before));
  const oldMessages = before.messages as ChatMessage[];
  const newMessages = after.messages as ChatMessage[];
  expect(newMessages).toHaveLength(oldMessages.length);
  const canonicalIndex = oldMessages.findIndex(message => message.content.startsWith(canonicalPrefix));
  const oldContext = JSON.parse(oldMessages[canonicalIndex]!.content.slice(canonicalPrefix.length));
  const newContext = JSON.parse(newMessages[canonicalIndex]!.content.slice(canonicalPrefix.length));
  const contractText: string = oldContext.payloadContract.instructions;
  const changed = newMessages.flatMap((message, index) => JSON.stringify(message) === JSON.stringify(oldMessages[index]) ? [] : [index]);
  const systemIndex = changed.find(index => newMessages[index]!.role === "system")!;
  expect(changed).toEqual([systemIndex, canonicalIndex]);
  expect(newMessages[systemIndex]!.content).toBe(oldMessages[systemIndex]!.content + "\n" + contractText);
  const systemText = newMessages.filter(message => message.role === "system").map(message => message.content).join("\n");
  expect(systemText.split(contractText)).toHaveLength(2);
  expect(newContext.payloadContract).not.toHaveProperty("instructions");
  expect(newContext.payloadContract).toEqual({ minBytes: oldContext.payloadContract.minBytes,
    maxBytes: oldContext.payloadContract.maxBytes });
  const expectedContext = structuredClone(oldContext);
  delete expectedContext.payloadContract.instructions;
  expect(newContext).toEqual(expectedContext);
  const target = newMessages.find(message => message.content.startsWith('{"kind":"runtime_payload_target_content_v1"'))!;
  expect(target.content.slice(target.content.indexOf("\n") + 1)).toBe(FULL_TARGET_SOURCE);
  expect(actual.execute.mock.calls[0]![0]).toEqual(baseline.execute.mock.calls[0]![0]);
  expect(captured).toHaveLength(2);
  for (const entry of captured) expect(JSON.stringify(entry.input)).toBe(entry.before);
  const raw = captured[1]!;
  expect(raw.metadata.payloadContract).toBe(raw.input.context.payloadContract);
  expect(raw.input.context.payloadContract.instructions).toBe(contractText);
  expect(raw.result.metadata.targetContext).toBe(raw.metadata.targetContext);
  expect(raw.result.metadata.materializedParams).toBe(raw.metadata.materializedParams);
  expect(raw.result.metadata.settledCapabilityResults).toBe(raw.metadata.settledCapabilityResults);
  expect(raw.result.metadata).not.toBe(raw.metadata);
});

test.each(["execution-agent-v1", undefined] as const)("%s keeps every composed provider byte unchanged", async policyId => {
  const bypass = vi.spyOn(projection, "projectSuperPayloadContract")
    .mockImplementation((input, _authority, metadata) => ({ instructions: input.instructions, metadata }));
  const baseline = await fullTargetContextFixture(root, policyId);
  await baseline.run();
  bypass.mockRestore();
  const actual = await fullTargetContextFixture(root, policyId);
  await actual.run();
  expect(JSON.stringify(actual.invoke.mock.calls.map(([input]) => input)))
    .toBe(JSON.stringify(baseline.invoke.mock.calls.map(([input]) => input)));
  expect(actual.execute.mock.calls[0]![0]).toEqual(baseline.execute.mock.calls[0]![0]);
});

test("ordinary SUPER single-stage writes keep every composed provider byte unchanged", async () => {
  const bypass = vi.spyOn(projection, "projectSuperPayloadContract")
    .mockImplementation((input, _authority, metadata) => ({ instructions: input.instructions, metadata }));
  const baseline = await fullTargetContextFixture(root, "supervisor-worker-v1", false);
  await baseline.run();
  bypass.mockRestore();
  const actual = await fullTargetContextFixture(root, "supervisor-worker-v1", false);
  await actual.run();
  expect(actual.invoke).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(actual.invoke.mock.calls[0]![0])).toBe(JSON.stringify(baseline.invoke.mock.calls[0]![0]));
});

test("a composed root payload stays byte-identical even when offered SUPER projection authority", async () => {
  const baseline = await fullTargetContextFixture(root, "execution-agent-v1");
  await baseline.run();
  vi.spyOn(projection, "projectSuperPayloadContract").mockImplementation((input, _authority, metadata) =>
    project(input, superAuthority, metadata));
  const actual = await fullTargetContextFixture(root, "execution-agent-v1");
  await actual.run();
  expect(JSON.stringify(actual.invoke.mock.calls.map(([input]) => input)))
    .toBe(JSON.stringify(baseline.invoke.mock.calls.map(([input]) => input)));
});

test("projection preserves the immutable source objects and exact captured whitespace", () => {
  const input = fixtureInput();
  const context = input.context;
  const metadata = Object.freeze({ ...context });
  const before = JSON.stringify(input);
  const result = project(input, superAuthority, metadata);
  expect(result.instructions).toBe(input.instructions + "\n" + context.payloadContract.instructions);
  expect(result.metadata.payloadContract).toEqual({ minBytes: 1, maxBytes: 4096 });
  expect(input.context).toBe(context);
  expect(JSON.stringify(input)).toBe(before);
  expect(result.metadata.targetContext).toBe(context.targetContext);
  expect(result.metadata.materializedParams).toBe(context.materializedParams);
});

test.each([
  ["selector", (input: WorkerCapabilityPayloadModelRequest) => ({ ...input, responseFormat: "json" as const })],
  ["contract format", (input: WorkerCapabilityPayloadModelRequest) => ({ ...input, context: { ...input.context,
    payloadContract: { ...input.context.payloadContract, responseFormat: "json" as const } } })],
  ["first stage", (input: WorkerCapabilityPayloadModelRequest) => ({ ...input, context: { ...input.context,
    payloadStage: { index: 1, count: 2, outputParam: "selection" } } })],
  ["nonfinal stage", (input: WorkerCapabilityPayloadModelRequest) => ({ ...input, context: { ...input.context,
    payloadStage: { index: 2, count: 3, outputParam: "content" } } })],
  ["single stage", (input: WorkerCapabilityPayloadModelRequest) => ({ ...input, context: { ...input.context,
    payloadStage: { index: 1, count: 1, outputParam: "content" } } })],
  ["missing stage", (input: WorkerCapabilityPayloadModelRequest) => ({ ...input, context: { ...input.context, payloadStage: undefined } })],
  ["missing target", (input: WorkerCapabilityPayloadModelRequest) => ({ ...input, context: { ...input.context, targetContext: undefined } })],
  ["full target presentation", (input: WorkerCapabilityPayloadModelRequest) => ({ ...input, context: { ...input.context,
    targetContext: { ...input.context.targetContext!, presentation: "full" as const } } })],
  ["target-only scope", (input: WorkerCapabilityPayloadModelRequest) => ({ ...input, context: { ...input.context, contextScope: "target_only" as const } })],
  ["stage scope mismatch", (input: WorkerCapabilityPayloadModelRequest) => ({ ...input, context: { ...input.context,
    payloadStage: { ...input.context.payloadStage!, contextScope: "target_only" as const } } })],
] as const)("%s returns original instructions and metadata", (_name, alter) => {
  const input = alter(fixtureInput());
  const metadata = { ...input.context };
  const result = project(input, superAuthority, metadata);
  expect(result.instructions).toBe(input.instructions);
  expect(result.metadata).toBe(metadata);
});

test.each([undefined, eaAuthority, { ...superAuthority, definitionHash: "other" }])(
  "nonmatching policy retains original instructions and metadata", authority => {
    const input = fixtureInput(); const metadata = { ...input.context };
    expect(project(input, authority, metadata)).toEqual({ instructions: input.instructions, metadata });
    expect(project(input, authority, metadata).metadata).toBe(metadata);
  },
);

test("mismatched projected contract is never promoted or rewritten", () => {
  const input = fixtureInput();
  const metadata = { ...input.context, payloadContract: { ...input.context.payloadContract, instructions: "other contract" } };
  expect(project(input, superAuthority, metadata).metadata).toBe(metadata);
});

function fixtureInput(): WorkerCapabilityPayloadModelRequest {
  return Object.freeze({ executionId: "capability-execution-2", modelStep: "tool_payload.raw",
    requestSourceProjection: "assignment_only", instructions: "Existing raw instructions.",
    context: Object.freeze({
      worker: Object.freeze({ callId: "call-3", parentCallId: "call-2", invocationAttempt: 2, objective: "Apply the accepted change." }),
      acceptedCapability: Object.freeze({ capabilityId: "fixture_edit", summary: "Edit the selected target.",
        authoringObjective: "Make the accepted change.", controls: Object.freeze({ path: "target.txt" }) }),
      contextScope: "target_with_artifacts", settledCapabilityResults: Object.freeze([]),
      payloadContract: Object.freeze({ instructions: "  Exact captured contract.\nPreserve this whitespace.\n", minBytes: 1, maxBytes: 4096 }),
      payloadStage: Object.freeze({ index: 2, count: 2, outputParam: "content", contextScope: "target_with_artifacts" }),
      materializedParams: Object.freeze({ selection: '{"placement":"after","start_line":2,"end_line":2}' }),
      targetContext: Object.freeze({ targetParam: "path", targetPath: "target.txt", presentation: "bounded", content: "one\ntwo\nthree",
        sourceRange: Object.freeze({ contextStartLine: 1, contextEndLine: 3, writableStartLine: 2, writableEndLine: 2, totalLines: 3 }) }),
    }),
  });
}
