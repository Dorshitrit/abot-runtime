import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { SessionRecord } from "../../sessions/types.js";
import { EXECUTION_TOOL_OBSERVATION_KIND } from "../../sessions/memory/execution-observation.js";
import { createRequestSessionMemory, type SessionMemoryCompactor } from "../context/session-memory/index.js";
import { buildFilePayloadInput } from "../request/execution-file-payload/context.js";
import { routeFilePayloadAuthor } from "../request/execution-file-payload/author.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { filePayloadEvidence, filePayloadFixture, filePayloadInput, filePayloadSource } from "./support/execution-file-payload-fixture.js";
import { filePayloadOutput } from "./support/execution-file-output-fixture.js";

const DETAIL = "CANONICAL_HISTORY_TOOL_FACT";
const SUMMARY = `Prior tool established ${DETAIL}.`;
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each([false, true])("EA file author preserves passive history through intervening turns and prior compaction (%s)", async (compacted) => {
  const f = await historyFixture();
  if (compacted) {
    const prepared = await f.memory.prepare(f.request);
    await prepared.commit();
  }
  const projection = buildFilePayloadInput(f.request, filePayloadInput());
  const text = JSON.stringify(projection.messages);
  expect(text.split(DETAIL)).toHaveLength(2);
  expect(text.split(f.request.prompt)).toHaveLength(2);
  expect(text).not.toContain("HISTORICAL_ASSISTANT_CLAIM");
  expect(filePayloadEvidence(projection.messages).settledCapabilityResults).toEqual([]);
  expect(projection.messages.filter(({ role }) => role === "tool" || role === "assistant")).toEqual([]);
  const source = filePayloadSource(projection.messages);
  expect(projection.messages.filter(({ content }) => content.startsWith('{"kind":"execution_file_source_v1"'))).toEqual([source]);
  expect(projection.messages.at(-1)).toEqual(source);
  expect(JSON.parse(source!.content)).toMatchObject({ sourceText: "EXACT_TARGET\r\n",
    sourceState: "current_at_payload_preparation", coverage: "complete_selected_range" });
  if (compacted) expect(text).toContain(SUMMARY);
  else expect(text).toContain("runtime_execution_history_reference_v1");
});

test("file RAW admission compacts history with the existing controller without losing exact target or task", async () => {
  const f = await historyFixture();
  f.counts.push(30_000, 1_000);
  f.invoke.mockImplementation(async (input) => ({ text: filePayloadOutput(input.messages, "accepted body"), meta: {} }));
  const input = filePayloadInput();
  const expectedSource = filePayloadSource(buildFilePayloadInput(f.request, input).messages);
  const author = routeFilePayloadAuthor(f.request, { author: vi.fn() },
    resolveRequestExecutionPolicy("execution-agent-v1").authority);
  await expect(author.author(input)).resolves.toEqual({ status: "authored", body: "accepted body" });
  expect(f.compact).toHaveBeenCalledOnce();
  expect(f.invoke).toHaveBeenCalledOnce();
  const invoked = f.invoke.mock.calls[0]![0];
  expect(invoked.modelStep).toBe("execution.file_payload.raw");
  const messages = invoked.messages as readonly ChatMessage[];
  expect(messages.filter(({ content }) => content.startsWith('{"kind":"execution_file_source_v1"'))).toEqual([expectedSource]);
  expect(messages.at(-1)).toEqual(expectedSource);
  const text = messages.map(({ content }) => content).join("\n");
  expect(text).toContain(SUMMARY);
  expect(text).toContain("EXACT_TARGET\\r\\n");
  expect(text).toContain("Apply the accepted precise file change.");
  expect(text.split(f.request.prompt)).toHaveLength(2);
});

async function historyFixture() {
  const createdAt = "2026-11-15T06:00:00.000Z";
  const messages: SessionRecord["messages"] = [
    { id: "old-u", role: "user", content: "Find the source fact.", createdAt, requestId: "old" },
    { id: "old-a", role: "assistant", content: "HISTORICAL_ASSISTANT_CLAIM", createdAt, requestId: "old",
      observationContent: JSON.stringify({ kind: EXECUTION_TOOL_OBSERVATION_KIND, requestId: "old",
        results: [{ executionId: "old-read", capabilityId: "read_text", outcome: "succeeded", referenceData: DETAIL }] }) },
    { id: "other-u", role: "user", content: "An intervening question.", createdAt, requestId: "other" },
    { id: "other-a", role: "assistant", content: "An intervening answer.", createdAt, requestId: "other" },
  ];
  const session: SessionRecord = { id: "file-history", title: "File editing", createdAt, updatedAt: createdAt,
    lastAgentMode: "reasoning", messageCount: messages.length, messages };
  const compact = vi.fn<SessionMemoryCompactor["compact"]>(async () => SUMMARY);
  const memory = createRequestSessionMemory({ sessionId: session.id, session, scope: "execution_agent",
    compactor: { compact }, repository: { compareAndSwapSessionMemoryCheckpoint: async (_id, command) =>
      ({ committed: true, checkpoint: command.checkpoint }) } });
  const f = await filePayloadFixture({ sessionId: session.id, sessionMemory: memory,
    historyMessages: messages.map(({ id, role, content, createdAt, requestId }) => ({ id, role, content, createdAt, requestId })) });
  return { ...f, memory, compact };
}
