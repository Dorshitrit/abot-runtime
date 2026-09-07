import { describe, expect, test } from "vitest";
import { buildConversationRoleCards } from "../../web-ui/app/lib/conversation-role-model.js";

const requestId = "ownership";
const stage = (role: string, eventSequence: number) => ({
  requestId,
  name: "runtime.state",
  stage: role,
  phase: "working",
  eventSequence,
});
const tool = (
  name: string,
  eventSequence: number,
  extra: Record<string, unknown> = {},
) => ({
  requestId,
  name,
  tool: "write_file",
  executionId: "write-1",
  eventSequence,
  meta: { path: "a.txt" },
  ...extra,
});
const cards = (events: Record<string, unknown>[]) =>
  buildConversationRoleCards({ requestId, events, streaming: true });

describe("tool executor ownership", () => {
  test("keeps a Worker's late completion under Worker through the complete handoff chain", () => {
    const result = cards([
      stage("supervisor", 1),
      stage("planner", 2),
      stage("worker", 3),
      tool("tool.payload.started", 4, {
        executorRole: "worker",
        roleCallId: "worker-call",
      }),
      tool("tool.started", 5, {
        executorRole: "worker",
        roleCallId: "worker-call",
      }),
      stage("reviewer", 6),
      stage("supervisor", 7),
      tool("tool.completed", 8, {
        executorRole: "worker",
        roleCallId: "worker-call",
        ok: true,
      }),
    ]);
    expect(result.map((card) => card.role)).toEqual([
      "supervisor",
      "planner",
      "worker",
      "reviewer",
    ]);
    expect(result.find((card) => card.role === "worker")!.toolActions).toEqual([
      expect.objectContaining({
        executorRole: "worker",
        roleCallId: "worker-call",
        status: "completed",
        count: 1,
      }),
    ]);
    expect(
      result
        .filter((card) => card.role !== "worker")
        .every((card) => !card.toolActions!.length),
    ).toBe(true);
    expect(
      result.filter((card) => card.active).map((card) => card.role),
    ).toEqual(["supervisor"]);
  });

  test("explicit identity overrides temporal attribution even if only completion contains it", () => {
    const result = cards([
      stage("reviewer", 1),
      tool("tool.started", 2),
      tool("tool.completed", 3, { executorRole: "worker", ok: true }),
    ]);
    expect(
      result.find((card) => card.role === "reviewer")!.toolActions,
    ).toEqual([]);
    expect(
      result.find((card) => card.role === "worker")!.toolActions,
    ).toHaveLength(1);
  });

  test("same-tool concurrency stays with each executor and call", () => {
    const result = cards([
      tool("tool.started", 1, {
        executorRole: "worker",
        roleCallId: "worker-call",
      }),
      tool("tool.started", 2, {
        executionId: "write-2",
        executorRole: "supervisor",
        roleCallId: "root-call",
      }),
      tool("tool.completed", 3, {
        executionId: "write-2",
        executorRole: "supervisor",
        roleCallId: "root-call",
        ok: true,
      }),
      tool("tool.completed", 4, {
        executorRole: "worker",
        roleCallId: "worker-call",
        ok: true,
      }),
    ]);
    expect(result.map((card) => card.toolActions!.length)).toEqual([1, 1]);
    expect(result[1]).toMatchObject({
      title: "Root agent",
      toolActions: [expect.objectContaining({ roleCallId: "root-call" })],
    });
  });

  test("correlated events without recorded executor identity remain unattributed across a handoff", () => {
    const result = cards([
      stage("worker", 1),
      tool("tool.started", 2),
      stage("reviewer", 3),
      tool("tool.completed", 4, { ok: true }),
    ]);
    expect(
      result.find((card) => card.role === "unknown")!.toolActions,
    ).toHaveLength(1);
    expect(result.find((card) => card.role === "worker")!.toolActions).toEqual(
      [],
    );
    expect(
      result.find((card) => card.role === "reviewer")!.toolActions,
    ).toEqual([]);
    const terminalOnly = cards([
      stage("reviewer", 1),
      tool("tool.completed", 2, { ok: true }),
    ]);
    expect(
      terminalOnly.find((card) => card.role === "unknown")!.toolActions,
    ).toHaveLength(1);
  });

  test("absent or unsupported executor identity remains explicitly unattributed", () => {
    const result = cards([
      tool("tool.completed", 1, { ok: true }),
      stage("worker", 2),
      tool("tool.completed", 3, {
        executionId: "other",
        executorRole: "unknown-new-role",
        ok: true,
      }),
    ]);
    expect(
      result.find((card) => card.role === "unknown")!.toolActions,
    ).toHaveLength(2);
    expect(result.find((card) => card.role === "worker")!.toolActions).toEqual(
      [],
    );
  });
});
