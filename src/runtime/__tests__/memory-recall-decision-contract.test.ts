import { describe, expect, test } from "vitest";
import { toOpenAIResponsesTextFormat } from "../../model-gateway/structured-output.js";
import { ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH } from "../orchestration/role-calls/memory-recall-contract.js";
import { createExecutionAgentDecisionFormat } from "../steps/execution-agent/format.js";
import { parseExecutionAgentDecisionOutput } from "../steps/execution-agent/parser.js";
import { createSupervisorDecisionFormat } from "../steps/supervisor-decision/format.js";
import { parseSupervisorDecisionOutput } from "../steps/supervisor-decision/parser.js";

const CONTRACTS = [
  {
    name: "Supervisor",
    format: createSupervisorDecisionFormat,
    parse: parseSupervisorDecisionOutput,
  },
  {
    name: "Execution Agent",
    format: createExecutionAgentDecisionFormat,
    parse: parseExecutionAgentDecisionOutput,
  },
] as const;

describe.each(CONTRACTS)(
  "$name memory recall decision",
  ({ format, parse }) => {
    test("offers and parses recall only when explicitly available", () => {
      const disabled = format();
      const explicitDisabled = format({ allowMemoryRecall: false });
      const enabled = format({ allowMemoryRecall: true });
      expect(explicitDisabled).toEqual(disabled);
      expect(JSON.stringify(disabled.schema)).not.toContain('"recall_memory"');
      expect(JSON.stringify(enabled.schema)).toContain('"recall_memory"');
      expect(() => toOpenAIResponsesTextFormat(enabled)).not.toThrow();

      const text = envelope({
        action: "recall_memory",
        query: "  saved style preference  ",
      });
      expect(parse(text)).toMatchObject({ ok: false, stage: "domain_parser" });
      expect(parse(text, { allowMemoryRecall: true })).toEqual({
        ok: true,
        decision: { action: "recall_memory", query: "saved style preference" },
      });
    });

    test.each([
      { query: "" },
      { query: "   " },
      { query: 23 },
      { query: "a".repeat(ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH + 1) },
      { query: "valid", roleId: "worker" },
      { query: "valid", capabilityId: "memory.search" },
      { query: "valid", memoryCandidates: [] },
    ])("rejects invalid or broadened recall fields: %j", (fields) => {
      expect(
        parse(envelope({ action: "recall_memory", ...fields }), {
          allowMemoryRecall: true,
        }),
      ).toMatchObject({ ok: false, stage: "domain_parser" });
    });

    test("preserves required presentation fields without creating role or tool fields", () => {
      const options = {
        allowMemoryRecall: true,
        includeAcknowledgement: true,
        includeTitle: true,
      };
      const decision = {
        action: "recall_memory",
        query: "preferred style",
        acknowledgement: "Checking saved context.",
        title: "Saved preference",
      };
      expect(parse(envelope(decision), options)).toEqual({
        ok: true,
        decision,
      });
      expect(
        parse(
          envelope({ action: "recall_memory", query: "preferred style" }),
          options,
        ),
      ).toMatchObject({ ok: false });
    });

    test("keeps ordinary respond parsing unchanged when recall becomes available", () => {
      const text = envelope({ action: "respond" });
      expect(parse(text, { allowMemoryRecall: true })).toEqual(parse(text));
    });
  },
);

function envelope(decision: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ decision });
}
