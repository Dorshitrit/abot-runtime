import { describe, expect, it } from "vitest";

import {
  buildRequestSourceMessage,
  projectRequestSource,
  REQUEST_SOURCE_MESSAGE_KIND,
} from "../context/request-source.js";

describe("request source context", () => {
  it("preserves the exact current request without normalization", () => {
    const prompt =
      "  Create note.txt with exactly:\nשלום  world\nand keep trailing space.  ";
    const view = projectRequestSource({
      requestId: "request-source-exact",
      prompt,
      modelStep: "worker.decision",
      callId: "call-2",
    });

    expect(view).toEqual({
      requestId: "request-source-exact",
      sourceRef: "request:request-source-exact",
      currentRequest: prompt,
    });
    expect(Object.isFrozen(view)).toBe(true);

    const message = buildRequestSourceMessage(view);
    expect(Object.isFrozen(message)).toBe(true);
    expect(message.role).toBe("user");
    expect(JSON.parse(message.content)).toEqual({
      kind: REQUEST_SOURCE_MESSAGE_KIND,
      authority: "reference_data",
      sourceRef: "request:request-source-exact",
      currentRequest: prompt,
    });
  });

  it("projects the latest complete visible turn without normalizing content", () => {
    const priorUser = "  Please prepare a summary.  ";
    const priorAssistant = "  Exact summary\nline two\\nliteral  ";
    const view = projectRequestSource({
      requestId: "request-source-follow-up",
      prompt: "Save that for me.",
      modelStep: "worker.decision",
      callId: "call-2",
      historyMessages: [
        {
          id: "user-complete",
          role: "user",
          content: priorUser,
          requestId: "prior-request",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "assistant-complete",
          role: "assistant",
          content: priorAssistant,
          requestId: "prior-request",
          createdAt: "2026-08-01T00:00:01.000Z",
        },
        {
          id: "tool-observation-user",
          role: "user",
          content: "TOOL_USER_MUST_NOT_REACH_SOURCE",
          grounding: "tool_observation",
          createdAt: "2026-08-01T00:00:02.000Z",
        },
        {
          id: "tool-observation-assistant",
          role: "assistant",
          content: "TOOL_ASSISTANT_MUST_NOT_REACH_SOURCE",
          grounding: "tool_observation",
          createdAt: "2026-08-01T00:00:03.000Z",
        },
        {
          id: "trailing-user",
          role: "user",
          content: "TRAILING_UNMATCHED_USER_MUST_NOT_REPLACE_TURN",
          requestId: "trailing-request",
          createdAt: "2026-08-01T00:00:04.000Z",
        },
      ],
    });

    expect(view.precedingTurn).toEqual({
      user: {
        id: "user-complete",
        content: priorUser,
        requestId: "prior-request",
      },
      assistant: {
        id: "assistant-complete",
        content: priorAssistant,
        requestId: "prior-request",
      },
    });
    expect(Object.isFrozen(view.precedingTurn)).toBe(true);
    expect(Object.isFrozen(view.precedingTurn?.user)).toBe(true);
    expect(Object.isFrozen(view.precedingTurn?.assistant)).toBe(true);
    const serialized = buildRequestSourceMessage(view).content;
    expect(serialized).not.toContain("TOOL_USER_MUST_NOT_REACH_SOURCE");
    expect(serialized).not.toContain("TOOL_ASSISTANT_MUST_NOT_REACH_SOURCE");
    expect(serialized).not.toContain(
      "TRAILING_UNMATCHED_USER_MUST_NOT_REPLACE_TURN",
    );
  });

  it("omits precedingTurn when history has no complete visible turn", () => {
    const view = projectRequestSource({
      requestId: "request-source-no-turn",
      prompt: "Current request",
      modelStep: "worker.decision",
      callId: "call-2",
      historyMessages: [
        {
          id: "unmatched-user",
          role: "user",
          content: "Unanswered prior request",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "excluded-assistant",
          role: "assistant",
          content: "Excluded observation",
          grounding: "tool_observation",
          createdAt: "2026-08-01T00:00:01.000Z",
        },
      ],
    });

    expect(view).not.toHaveProperty("precedingTurn");
    expect(JSON.parse(buildRequestSourceMessage(view).content)).not.toHaveProperty(
      "precedingTurn",
    );
  });

  it("rejects missing request identity, call identity, or substantive source", () => {
    expect(() =>
      projectRequestSource({
        requestId: "",
        prompt: "Create note.txt",
        modelStep: "planner.decision",
        callId: "call-2",
      }),
    ).toThrow("request_source_input_invalid");
    expect(() =>
      projectRequestSource({
        requestId: "request-source-invalid",
        prompt: "   ",
        modelStep: "worker.decision",
        callId: "call-2",
      }),
    ).toThrow("request_source_input_invalid");
    expect(() =>
      projectRequestSource({
        requestId: "request-source-invalid",
        prompt: "Create note.txt",
        modelStep: "reviewer.decision",
        callId: "",
      }),
    ).toThrow("request_source_input_invalid");
  });
});
