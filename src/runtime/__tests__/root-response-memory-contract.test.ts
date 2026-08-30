import { describe, expect, test } from "vitest";

import {
  buildMemoryAuthoringInstructions,
  MAX_ROOT_MEMORY_CANDIDATES,
  parseRootAuthoredResponse,
} from "../orchestration/final-response/authoring-contract.js";
import { createRootAuthoredResponseFormat } from "../orchestration/final-response/format.js";
import { buildExecutionAgentResponseInstructions } from "../steps/execution-agent/response-prompt.js";
import { buildSupervisorResponseInstructions } from "../steps/supervisor-response/prompt.js";

describe("root response long-term-memory contract", () => {
  test("keeps a valid final response when individual candidates are malformed", () => {
    const parsed = parseRootAuthoredResponse(
      JSON.stringify({
        finalResponse: "A complete answer.",
        memoryCandidates: [
          { content: "User prefers concise answers.", tags: ["preference"] },
          { content: 42, tags: ["invalid"] },
          { content: "Valid without a valid tag array", tags: "wrong" },
        ],
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      decision: {
        finalResponse: "A complete answer.",
        memoryCandidates: [
          { content: "User prefers concise answers.", tags: ["preference"] },
          { content: "Valid without a valid tag array", tags: [] },
        ],
      },
    });
  });

  test("keeps finalResponse valid when the optional candidate channel is malformed", () => {
    expect(
      parseRootAuthoredResponse(
        JSON.stringify({
          finalResponse: "The full answer remains intact.",
          memoryCandidates: "not-an-array",
        }),
      ),
    ).toEqual({
      ok: true,
      decision: {
        finalResponse: "The full answer remains intact.",
        memoryCandidates: [],
      },
    });
  });

  test("bounds candidates independently of the final response", () => {
    const memoryCandidates = Array.from(
      { length: MAX_ROOT_MEMORY_CANDIDATES + 2 },
      (_, index) => ({ content: `Memory ${index}`, tags: ["fact"] }),
    );

    const parsed = parseRootAuthoredResponse(
      JSON.stringify({
        finalResponse: "The answer remains complete.",
        memoryCandidates,
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a valid root response");
    expect(parsed.decision.finalResponse).toBe("The answer remains complete.");
    expect(parsed.decision.memoryCandidates).toHaveLength(
      MAX_ROOT_MEMORY_CANDIDATES,
    );
    expect(parsed.decision.memoryCandidates.at(-1)?.content).toBe(
      `Memory ${MAX_ROOT_MEMORY_CANDIDATES - 1}`,
    );
  });

  test("rejects an invalid envelope before any text can be committed", () => {
    expect(parseRootAuthoredResponse("not-json")).toMatchObject({
      ok: false,
      stage: "root_authored_response",
      issues: [{ code: "root_authored_response_json_invalid" }],
    });
  });

  test("enforces the final response limit independently of candidates", () => {
    expect(
      parseRootAuthoredResponse(
        JSON.stringify({ finalResponse: "too long", memoryCandidates: [] }),
        { maxResponseChars: 3 },
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "root_authored_response_final_too_long" }],
    });
  });

  test("preserves marker-like text as ordinary user-facing content", () => {
    const finalResponse =
      "Explain <abot_internal_memory_candidates_v1> literally.";
    expect(
      parseRootAuthoredResponse(
        JSON.stringify({ finalResponse, memoryCandidates: [] }),
      ),
    ).toEqual({
      ok: true,
      decision: { finalResponse, memoryCandidates: [] },
    });
  });

  test("publishes one strict shared schema for both response paths", () => {
    expect(createRootAuthoredResponseFormat(500)).toMatchObject({
      type: "json_schema",
      name: "root_authored_response",
      strict: true,
      schema: {
        required: ["finalResponse", "memoryCandidates"],
        properties: {
          finalResponse: { type: "string", maxLength: 500 },
          memoryCandidates: {
            type: "array",
            maxItems: MAX_ROOT_MEMORY_CANDIDATES,
          },
        },
      },
    });
  });

  test("preserves raw-text response instructions while memory is disabled", () => {
    const supervisor = buildSupervisorResponseInstructions({
      hasCompletedChildResult: false,
      hasRequestToolResults: false,
    });
    const execution = buildExecutionAgentResponseInstructions();

    expect(supervisor).toContain("plain text");
    expect(execution).toContain("raw text");
    expect(supervisor).not.toContain("memoryCandidates");
    expect(execution).not.toContain("memoryCandidates");
  });

  test("keeps Supervisor raw while Execution Agent retains its combined envelope", () => {
    const supervisor = buildSupervisorResponseInstructions({
      hasCompletedChildResult: false,
      hasRequestToolResults: false,
    });
    const execution = buildExecutionAgentResponseInstructions(true);

    expect(supervisor).not.toContain("memoryCandidates");
    for (const instruction of buildMemoryAuthoringInstructions()) {
      expect(execution).toContain(instruction);
    }
  });
});
