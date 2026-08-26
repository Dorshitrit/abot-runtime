import { describe, expect, test } from "vitest";

import { buildContextBuckets } from "../../sessions/context-window.js";

describe("buildContextBuckets carry policy", () => {
  test("carries structured observation content without reusing the final assistant prose", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 3,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "What is my favorite color?",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content:
            "Your favorite color is blue. Regarding AI news, I should search the web.",
          createdAt: "2026-01-01T00:00:01.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "stable_fact" as const,
            carryPolicy: "always" as const,
          },
          observationContent: "My favorite color is blue.",
        },
        {
          id: "m-3",
          role: "assistant" as const,
          content: "How else can I help?",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      maxConversationMessages: 4,
      maxToolObservationMessages: 2,
    });

    expect(buckets.priorToolObservations).toEqual([
      {
        role: "system",
        contextMessageKind: "prior_tool_observation",
        content:
          "Context note: This message was derived from a previous tool-based observation and may not reflect current external state.\nMy favorite color is blue.",
      },
    ]);
    expect(buckets.recentConversation).toEqual([
      { role: "user", content: "What is my favorite color?" },
      { role: "assistant", content: "How else can I help?" },
    ]);
  });

  test("can suppress recent conversation while preserving carryable observations", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 2,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "Search the web for AI news.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "Your name is Test User.",
          createdAt: "2026-01-01T00:00:01.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "stable_fact" as const,
            carryPolicy: "always" as const,
          },
          observationContent: "My name is Test User.",
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      includeRecentConversation: false,
      maxConversationMessages: 4,
      maxToolObservationMessages: 2,
    });

    expect(buckets.recentConversation).toEqual([]);
    expect(buckets.priorToolObservations).toEqual([
      {
        role: "system",
        contextMessageKind: "prior_tool_observation",
        content:
          "Context note: This message was derived from a previous tool-based observation and may not reflect current external state.\nMy name is Test User.",
      },
    ]);
  });

  test("treats non-carry task results as a boundary for older conversation", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 2,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "Build the project landing page.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "The landing page has been created.",
          createdAt: "2026-01-01T00:00:01.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "never" as const,
          },
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      maxConversationMessages: 4,
      maxToolObservationMessages: 2,
    });

    expect(buckets.recentConversation).toEqual([]);
    expect(buckets.priorToolObservations).toEqual([]);
  });

  test("uses a carryable task-result snapshot as the continuity boundary", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 3,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "Create the project page in sandbox/demo/index.html.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "The page has been fixed.",
          createdAt: "2026-01-01T00:00:01.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
          },
          observationContent:
            [
              "Development continuity snapshot:",
              "Model work state:",
              "Artifacts:",
              "- sandbox/demo/index.html lastTool=write_file mutations=1",
            ].join("\n"),
        },
        {
          id: "m-3",
          role: "assistant" as const,
          content: "Anything else?",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      maxConversationMessages: 4,
      maxToolObservationMessages: 2,
    });

    expect(buckets.priorToolObservations).toEqual([
      {
        role: "system",
        contextMessageKind: "development_task_result_observation",
        content:
          [
            "Context note: This message was derived from a previous tool-based observation and may not reflect current external state.",
            "Development continuity snapshot:",
            "Model work state:",
            "Artifacts:",
            "- sandbox/demo/index.html lastTool=write_file mutations=1",
          ].join("\n"),
      },
    ]);
    expect(buckets.recentConversation).toEqual([
      { role: "assistant", content: "Anything else?" },
    ]);
  });

  test("continues across carryable task-result boundaries without reusing observation-backed assistant prose", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 4,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "The layout bug still exists.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "I found conflicting CSS and will consolidate style.css.",
          createdAt: "2026-01-01T00:00:01.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
          },
          observationContent:
            "Development continuity snapshot:\nLatest grounded steps:\n- read_file path=sandbox/demo/style.css",
        },
        {
          id: "m-3",
          role: "user" as const,
          content: "Ok do it",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      maxConversationMessages: 4,
      maxToolObservationMessages: 2,
      includeRecentConversationAcrossTaskResults: true,
    });

    expect(buckets.recentConversation).toEqual([
      { role: "user", content: "The layout bug still exists." },
      { role: "user", content: "Ok do it" },
    ]);
    expect(buckets.priorToolObservations[0]?.content).toContain(
      "Development continuity snapshot:",
    );
  });

  test("carries only the latest carryable task-result snapshot when newer ones supersede older ones", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 5,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "Build the page.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "Initial carry",
          createdAt: "2026-01-01T00:00:01.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
          },
          observationContent:
            "Development continuity snapshot:\nSummary: initial snapshot",
        },
        {
          id: "m-3",
          role: "user" as const,
          content: "Continue",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
        {
          id: "m-4",
          role: "assistant" as const,
          content: "Latest carry",
          createdAt: "2026-01-01T00:00:03.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
          },
          observationContent:
            "Development continuity snapshot:\nSummary: latest snapshot",
        },
        {
          id: "m-5",
          role: "assistant" as const,
          content: "Anything else?",
          createdAt: "2026-01-01T00:00:04.000Z",
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      maxConversationMessages: 4,
      maxToolObservationMessages: 4,
      includeRecentConversationAcrossTaskResults: true,
    });

    expect(buckets.priorToolObservations).toEqual([
      {
        role: "system",
        contextMessageKind: "development_task_result_observation",
        content:
          "Context note: This message was derived from a previous tool-based observation and may not reflect current external state.\nDevelopment continuity snapshot:\nSummary: latest snapshot",
      },
    ]);
  });

  test("can include plain task-result prose across task-result boundaries when no observation source exists", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 4,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "Explain the repo structure.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "The repo has runtime and tools folders.",
          createdAt: "2026-01-01T00:00:01.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
          },
        },
        {
          id: "m-3",
          role: "user" as const,
          content: "Continue",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      maxConversationMessages: 4,
      maxToolObservationMessages: 2,
      includeRecentConversationAcrossTaskResults: true,
    });

    expect(buckets.recentConversation).toEqual([
      { role: "user", content: "Explain the repo structure." },
      {
        role: "assistant",
        content: "The repo has runtime and tools folders.",
      },
      { role: "user", content: "Continue" },
    ]);
    expect(buckets.priorToolObservations).toEqual([]);
  });

  test("keeps the latest authoritative project handoff when a newer supplemental follow-up result exists", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 5,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "Build the page.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "Project carry",
          createdAt: "2026-01-01T00:00:01.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
            taskResultRole: "authoritative_project_handoff" as const,
          },
          observationContent:
            "Development continuity snapshot:\nSummary: project handoff",
        },
        {
          id: "m-3",
          role: "user" as const,
          content: "What files are there?",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
        {
          id: "m-4",
          role: "assistant" as const,
          content: "Inspection carry",
          createdAt: "2026-01-01T00:00:03.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
            taskResultRole: "supplemental_follow_up" as const,
          },
          observationContent:
            "Development continuity snapshot:\nSummary: file listing result",
        },
        {
          id: "m-5",
          role: "assistant" as const,
          content: "Anything else?",
          createdAt: "2026-01-01T00:00:04.000Z",
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      maxConversationMessages: 4,
      maxToolObservationMessages: 4,
      includeRecentConversationAcrossTaskResults: true,
    });

    expect(buckets.priorToolObservations).toEqual([
      {
        role: "system",
        contextMessageKind: "development_task_result_observation",
        taskResultRole: "supplemental_follow_up",
        content:
          "Context note: This message was derived from a previous tool-based observation and may not reflect current external state.\nDevelopment continuity snapshot:\nSummary: file listing result",
      },
      {
        role: "system",
        contextMessageKind: "development_task_result_observation",
        taskResultRole: "authoritative_project_handoff",
        content:
          "Context note: This message was derived from a previous tool-based observation and may not reflect current external state.\nDevelopment continuity snapshot:\nSummary: project handoff",
      },
    ]);
  });

  test("carries dedicated context entries without adding assistant prose to conversation context", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 2,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "Build the page.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "I am still working.",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      contextEntries: [
        {
          id: "ctx-1",
          kind: "tool_observation" as const,
          createdAt: "2026-01-01T00:00:02.000Z",
          content:
            "Development continuity snapshot:\nSummary: checkpoint before finalization",
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
            taskResultRole: "authoritative_project_handoff" as const,
          },
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      maxConversationMessages: 4,
      maxToolObservationMessages: 4,
    });

    expect(buckets.recentConversation).toEqual([
      { role: "user", content: "Build the page." },
      { role: "assistant", content: "I am still working." },
    ]);
    expect(buckets.priorToolObservations).toEqual([
      {
        role: "system",
        contextMessageKind: "development_task_result_observation",
        taskResultRole: "authoritative_project_handoff",
        content:
          "Context note: This message was derived from a previous tool-based observation and may not reflect current external state.\nDevelopment continuity snapshot:\nSummary: checkpoint before finalization",
      },
    ]);
  });

  test("uses the newest dedicated context entry over older task-result message carry", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 2,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "Continue.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "Older final.",
          createdAt: "2026-01-01T00:00:01.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
            taskResultRole: "authoritative_project_handoff" as const,
          },
          observationContent:
            "Development continuity snapshot:\nSummary: older handoff",
        },
      ],
      contextEntries: [
        {
          id: "ctx-1",
          kind: "tool_observation" as const,
          createdAt: "2026-01-01T00:00:03.000Z",
          content:
            "Development continuity snapshot:\nSummary: newer checkpoint",
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
            taskResultRole: "authoritative_project_handoff" as const,
          },
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      maxConversationMessages: 4,
      maxToolObservationMessages: 4,
      includeRecentConversationAcrossTaskResults: true,
    });

    expect(buckets.priorToolObservations).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("Summary: newer checkpoint"),
      }),
    ]);
    expect(buckets.priorToolObservations[0]?.content).not.toContain(
      "Summary: older handoff",
    );
  });

  test("keeps final task-result messages over context entries with matching timestamps", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 2,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "Continue.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "Final answer.",
          createdAt: "2026-01-01T00:00:03.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
            taskResultRole: "authoritative_project_handoff" as const,
          },
          observationContent:
            "Development continuity snapshot:\nSummary: final handoff",
        },
      ],
      contextEntries: [
        {
          id: "ctx-1",
          kind: "tool_observation" as const,
          createdAt: "2026-01-01T00:00:03.000Z",
          content:
            "Development continuity snapshot:\nSummary: older checkpoint",
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
            taskResultRole: "authoritative_project_handoff" as const,
          },
        },
        {
          id: "ctx-2",
          kind: "tool_observation" as const,
          createdAt: "2026-01-01T00:00:03.000Z",
          content:
            "Development continuity snapshot:\nSummary: later checkpoint array slot",
          observationMeta: {
            kind: "task_result" as const,
            carryPolicy: "always" as const,
            taskResultRole: "authoritative_project_handoff" as const,
          },
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      maxConversationMessages: 4,
      maxToolObservationMessages: 4,
      includeRecentConversationAcrossTaskResults: true,
    });

    expect(buckets.priorToolObservations).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("Summary: final handoff"),
      }),
    ]);
    expect(buckets.priorToolObservations[0]?.content).not.toContain(
      "checkpoint",
    );
  });
});
