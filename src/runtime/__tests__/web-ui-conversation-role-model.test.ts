import { describe, expect, test } from "vitest";
import { buildConversationRoleCards } from "../../web-ui/app/lib/conversation-role-model.js";

const requestId = "request-role-flow";
const phase = (stage: string, action: string) => ({
  requestId,
  type: "event",
  eventName: "runtime.state",
  name: "Runtime activity",
  stage,
  phase: action,
  tone: "active",
});
const tool = (eventName: string, extra: Record<string, unknown> = {}) => ({
  requestId,
  type: "event",
  eventName,
  name: eventName,
  tool: "read_file",
  summary: "Read project notes",
  ...extra,
});
const chain = () => [
  phase("planner", "planning"),
  phase("worker", "working"),
  tool("tool.started", { count: 2 }),
  tool("tool.completed", { count: 2 }),
  phase("reviewer", "reviewing"),
  phase("planner", "planning"),
  phase("supervisor", "resuming"),
];

describe("conversation role cards", () => {
  test("follows delegated handoffs and reuses a role card when the role resumes", () => {
    const cards = buildConversationRoleCards({
      requestId,
      events: chain(),
      streaming: true,
    });
    expect(cards.map((card) => card.role)).toEqual([
      "planner",
      "worker",
      "reviewer",
      "supervisor",
    ]);
    expect(
      cards.filter((card) => card.active).map((card) => card.role),
    ).toEqual(["supervisor"]);
    expect(cards.find((card) => card.role === "worker")).toMatchObject({
      phaseLabel: "Working",
      summary: "Read project notes",
      facts: ["2 reads"],
      tone: "recorded",
    });
    expect(cards.at(-1)).toMatchObject({
      phaseLabel: "Resuming",
      tone: "active",
    });
  });

  test("restored history records activity without marking any role successful or active", () => {
    const cards = buildConversationRoleCards({
      requestId,
      events: chain(),
      streaming: false,
    });
    expect(cards).toHaveLength(4);
    expect(
      cards.every((card) => !card.active && card.tone === "recorded"),
    ).toBe(true);
  });

  test.each(["completed", "failed"])(
    "a %s request cannot leave a role active or assign its outcome to a role",
    (type) => {
      const cards = buildConversationRoleCards({
        requestId,
        streaming: true,
        events: [...chain(), { requestId, type, eventName: `request.${type}` }],
      });
      expect(
        cards.every((card) => !card.active && card.tone === "recorded"),
      ).toBe(true);
    },
  );

  test("reports an observed tool error only on its owning role, and allows later activity", () => {
    const events = [
      phase("planner", "planning"),
      phase("worker", "working"),
      tool("tool.failed", { tone: "failed", summary: "Permission denied" }),
    ];
    const cards = buildConversationRoleCards({
      requestId,
      events,
      streaming: true,
    });
    expect(cards[0]).toMatchObject({ role: "planner", tone: "recorded" });
    expect(cards[1]).toMatchObject({
      role: "worker",
      tone: "failed",
      active: false,
      summary: "Permission denied",
    });
    const resumed = buildConversationRoleCards({
      requestId,
      streaming: true,
      events: [...events, phase("worker", "working")],
    });
    expect(resumed[1]).toMatchObject({
      role: "worker",
      tone: "active",
      active: true,
    });
  });

  test("unknown stages break tool ownership without inventing a requested role", () => {
    const cards = buildConversationRoleCards({
      requestId,
      streaming: true,
      events: [
        phase("worker", "working"),
        phase("execution", "working"),
        tool("tool.started"),
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      role: "worker",
      facts: [],
      active: false,
      tone: "recorded",
    });
  });

  test("planner projections do not take tool activity away from the declared Worker", () => {
    const cards = buildConversationRoleCards({
      requestId,
      streaming: true,
      events: [
        phase("planner", "planning"),
        phase("worker", "working"),
        {
          requestId,
          eventName: "plan.snapshot",
          payload: {
            plan: { summary: "Project work", total: 2, completed: 1 },
          },
        },
        tool("tool.started"),
      ],
    });
    expect(cards.find((card) => card.role === "worker")).toMatchObject({
      facts: ["1 tool call"],
      active: true,
    });
    expect(cards.find((card) => card.role === "planner")?.facts).toEqual([]);
  });

  test("interleaved requests cannot change ownership or contribute tool counts", () => {
    const cards = buildConversationRoleCards({
      requestId,
      streaming: true,
      events: [
        phase("worker", "working"),
        { ...phase("reviewer", "reviewing"), requestId: "another-request" },
        { ...tool("tool.started"), requestId: "another-request" },
        { type: "failed", requestId: "another-request" },
        tool("tool.started"),
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      role: "worker",
      active: true,
      facts: ["1 tool call"],
    });
  });

  test("does not infer roles from text, model steps, missing metadata, or object property names", () => {
    expect(
      buildConversationRoleCards({
        requestId,
        streaming: true,
        events: [
          null,
          "Worker",
          { name: "Supervisor is working", requestId },
          { requestId, modelStep: "supervisor.decision" },
          phase("toString", "working"),
          phase("constructor", "working"),
        ],
      }),
    ).toEqual([]);
    expect(
      buildConversationRoleCards({ requestId: "", events: chain() }),
    ).toEqual([]);
  });

  test("keeps a newer live Reviewer active when older Worker history arrives afterward", () => {
    const events = [
      { ...phase("reviewer", "reviewing"), eventSequence: 20, lastSeqNo: 80 },
      { ...phase("planner", "planning"), eventSequence: 2, lastSeqNo: 90 },
      { ...phase("worker", "working"), eventSequence: 12, lastSeqNo: 91 },
      { ...tool("tool.started"), eventSequence: 13, lastSeqNo: 92 },
      { ...tool("tool.started"), eventSequence: 13, lastSeqNo: 93 },
    ];
    const cards = buildConversationRoleCards({
      requestId,
      events,
      streaming: true,
    });
    expect(cards.map((card) => card.role)).toEqual([
      "planner",
      "worker",
      "reviewer",
    ]);
    expect(
      cards.filter((card) => card.active).map((card) => card.role),
    ).toEqual(["reviewer"]);
    expect(cards.find((card) => card.role === "worker")?.facts).toEqual([
      "1 tool call",
    ]);
    expect(cards.find((card) => card.role === "reviewer")?.facts).toEqual([]);
  });

  test("orders sequence-only legacy history without mixing runtime and replay cursors", () => {
    const legacy = buildConversationRoleCards({
      requestId,
      streaming: true,
      events: [
        { ...phase("reviewer", "reviewing"), lastSeqNo: 12 },
        { ...phase("worker", "working"), lastSeqNo: 10 },
        { ...tool("tool.started"), lastSeqNo: 11 },
      ],
    });
    expect(legacy.map((card) => card.role)).toEqual(["worker", "reviewer"]);
    expect(legacy.at(-1)?.active).toBe(true);
    const mixed = buildConversationRoleCards({
      requestId,
      streaming: true,
      events: [
        { ...phase("worker", "working"), eventSequence: 100 },
        { ...phase("supervisor", "resuming"), lastSeqNo: 2 },
      ],
    });
    expect(mixed.map((card) => card.role)).toEqual(["worker", "supervisor"]);
    expect(mixed.at(-1)?.active).toBe(true);
  });

  test("keeps concrete tool evidence when a later role status only announces resuming work", () => {
    const cards = buildConversationRoleCards({
      requestId,
      streaming: true,
      events: [
        phase("worker", "working"),
        tool("tool.completed", {
          summary: "Updated index.html with the requested newsletter form",
        }),
        phase("reviewer", "reviewing"),
        phase("worker", "working"),
      ],
    });
    expect(cards.find((card) => card.role === "worker")).toMatchObject({
      responsibility: "Performs assigned tasks",
      summary: "Updated index.html with the requested newsletter form",
      active: true,
    });
    expect(cards.find((card) => card.role === "reviewer")).toMatchObject({
      responsibility: "Reviews the result",
      active: false,
    });
  });
});
