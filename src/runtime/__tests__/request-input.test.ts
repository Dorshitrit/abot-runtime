import { describe, expect, test } from "vitest";

import { parseRequestInput } from "../request/input.js";
import type { RunRequestMessage } from "../request/contracts.js";

describe("runtime request input", () => {
  test.each<{
    name: string;
    message: Partial<RunRequestMessage>;
    expectedSessionId: string;
    expectedPrompt: string;
  }>([
    {
      name: "prefers input over text",
      message: { sessionId: "  session-1  ", input: "input", text: "text" },
      expectedSessionId: "session-1",
      expectedPrompt: "input",
    },
    {
      name: "keeps an empty input instead of falling back to text",
      message: { sessionId: "session-2", input: "", text: "fallback" },
      expectedSessionId: "session-2",
      expectedPrompt: "",
    },
    {
      name: "falls back to text",
      message: { sessionId: "session-3", text: "text" },
      expectedSessionId: "session-3",
      expectedPrompt: "text",
    },
    {
      name: "normalizes missing values",
      message: { sessionId: 42 },
      expectedSessionId: "",
      expectedPrompt: "",
    },
  ])("$name", ({ message, expectedSessionId, expectedPrompt }) => {
    const parsed = parseRequestInput({
      type: "run_request",
      requestId: "req-runtime-input",
      ...message,
    });

    expect(parsed.sessionId).toBe(expectedSessionId);
    expect(parsed.prompt).toBe(expectedPrompt);
  });
});
