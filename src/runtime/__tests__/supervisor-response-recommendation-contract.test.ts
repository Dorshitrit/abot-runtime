import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  projectOllamaFormat,
  toOpenAIResponsesTextFormat,
} from "../../model-gateway/structured-output.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { createSupervisorDecisionFormat } from "../steps/supervisor-decision/format.js";
import { parseSupervisorDecisionOutput } from "../steps/supervisor-decision/parser.js";

type DecisionSchema = {
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
};

function schemaVariants(
  includeResponseRecommendation: boolean,
): DecisionSchema[] {
  const format = createSupervisorDecisionFormat({
    includeResponseRecommendation,
  });
  return readSchemaVariants(format.schema);
}

function readSchemaVariants(value: Record<string, unknown>): DecisionSchema[] {
  const schema = value as {
    properties: { decision: DecisionSchema & { anyOf?: DecisionSchema[] } };
  };
  return schema.properties.decision.anyOf ?? [schema.properties.decision];
}

function parseDecision(
  decision: Record<string, unknown>,
  includeResponseRecommendation = true,
) {
  return parseSupervisorDecisionOutput(JSON.stringify({ decision }), {
    includeResponseRecommendation,
  });
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("Supervisor direct-response recommendation contract", () => {
  test("requires a bounded recommendation only in the selected respond variant", () => {
    const [respond, ...invocations] = schemaVariants(true);
    expect(respond).toMatchObject({
      additionalProperties: false,
      required: ["action", "responseRecommendation"],
      properties: {
        responseRecommendation: {
          type: "string",
          minLength: 1,
          maxLength: 300,
        },
      },
    });
    expect(invocations).toEqual(schemaVariants(false).slice(1));
    expect(schemaVariants(false)[0].properties).not.toHaveProperty(
      "responseRecommendation",
    );
  });

  test.each([false, true])(
    "preserves provider compatibility, respond-only=%j",
    (respondOnly) => {
      const format = createSupervisorDecisionFormat({
        includeResponseRecommendation: true,
        ...(respondOnly ? { allowedRoleIds: [] } : {}),
      });
      const ollama = projectOllamaFormat(format);
      const projected = readSchemaVariants(
        ollama.format as Record<string, unknown>,
      )[0];
      expect(projected.required).toContain("responseRecommendation");
      expect(projected.properties.responseRecommendation).toEqual({
        type: "string",
        minLength: 1,
      });
      expect(ollama.diagnostics).toContainEqual({
        action: "removed",
        keyword: "maxLength",
        path: respondOnly
          ? "/properties/decision/properties/responseRecommendation/maxLength"
          : "/properties/decision/anyOf/0/properties/responseRecommendation/maxLength",
        reason: "ollama_grammar_unsupported_post_validated_constraint",
      });
      expect(toOpenAIResponsesTextFormat(format)).toEqual({
        type: "json_schema",
        name: "supervisor_decision",
        strict: true,
        schema: format.schema,
      });
      expect(
        parseDecision({
          action: "respond",
          responseRecommendation: "x".repeat(301),
        }),
      ).toEqual({ ok: true, decision: { action: "respond" } });
    },
  );

  test("retains the accepted recommendation and trims its surrounding whitespace", () => {
    const responseRecommendation =
      "Explain that coordinates identify locations, whereas directions describe orientations.";
    expect(
      parseDecision({
        action: "respond",
        responseRecommendation: `  ${responseRecommendation}  `,
      }),
    ).toEqual({
      ok: true,
      decision: { action: "respond", responseRecommendation },
    });
  });

  test.each([undefined, null, "", "   ", 17, "x".repeat(301)])(
    "preserves respond while omitting an unusable recommendation: %j",
    (responseRecommendation) => {
      expect(
        parseDecision({ action: "respond", responseRecommendation }),
      ).toEqual({ ok: true, decision: { action: "respond" } });
    },
  );

  test("does not forgive unrelated invalid fields when the recommendation is unusable", () => {
    expect(
      parseDecision({
        action: "respond",
        responseRecommendation: null,
        roleId: "worker",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseSupervisorDecisionOutput(
        JSON.stringify({
          decision: { action: "respond", responseRecommendation: null },
        }),
        { includeResponseRecommendation: true, includeAcknowledgement: true },
      ),
    ).toMatchObject({ ok: false });
  });

  test("accepts the exact 300-character boundary without truncation", () => {
    const responseRecommendation = "x".repeat(300);
    expect(
      parseDecision({ action: "respond", responseRecommendation }),
    ).toEqual({
      ok: true,
      decision: { action: "respond", responseRecommendation },
    });
  });

  test("keeps legacy respond unchanged when the recommendation is not requested", () => {
    expect(parseDecision({ action: "respond" }, false)).toEqual({
      ok: true,
      decision: { action: "respond" },
    });
    expect(
      parseSupervisorDecisionOutput(
        JSON.stringify({ decision: { action: "respond" } }),
      ),
    ).toEqual({ ok: true, decision: { action: "respond" } });
    expect(
      parseDecision(
        { action: "respond", responseRecommendation: "Unrequested text." },
        false,
      ),
    ).toMatchObject({ ok: false });
  });

  test.each(["worker", "planner"])(
    "keeps %s invocation unchanged and rejects a recommendation on that action",
    (roleId) => {
      const invocation = {
        action: "invoke_role",
        roleId,
        objective: "Inspect the requested external state.",
      };
      expect(parseDecision(invocation)).toEqual(
        parseDecision(invocation, false),
      );
      expect(parseDecision(invocation)).toMatchObject({ ok: true });
      expect(
        parseDecision({
          ...invocation,
          responseRecommendation: "This must not cross the role boundary.",
        }),
      ).toMatchObject({ ok: false });
    },
  );

  test("preserves acknowledgement and title beside the response recommendation", () => {
    const decision = {
      action: "respond",
      responseRecommendation:
        "Explain the difference between a location and an orientation.",
      acknowledgement: "I will explain the supplied information.",
      title: "Supplied information",
    };
    expect(
      parseSupervisorDecisionOutput(JSON.stringify({ decision }), {
        includeResponseRecommendation: true,
        includeAcknowledgement: true,
        includeTitle: true,
      }),
    ).toEqual({ ok: true, decision });
  });
});
