import { describe, expect, test } from "vitest";

import type { ModelGatewayJsonSchemaFormat } from "../types.js";
import {
  projectOpenAIResponsesFormat,
  projectOllamaFormat,
  toOpenAIResponsesTextFormat,
} from "./projection.js";

describe("provider schema projection", () => {
  test("removes only explicitly post-validated Ollama constraints with diagnostics", () => {
    const canonical: ModelGatewayJsonSchemaFormat = {
      type: "json_schema",
      name: "bounded_output",
      strict: true,
      postValidatedSchemaConstraints: [
        {
          keyword: "maxLength",
          path: "/properties/value/maxLength",
        },
      ],
      schema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            minLength: 1,
            maxLength: 32,
            pattern: "^[a-z]+$",
          },
        },
        required: ["value"],
        additionalProperties: false,
      },
    };
    const before = structuredClone(canonical);

    const projected = projectOllamaFormat(canonical);

    expect(canonical).toEqual(before);
    expect(projected.format).toEqual({
      type: "object",
      properties: {
        value: {
          type: "string",
          minLength: 1,
          pattern: "^[a-z]+$",
        },
      },
      required: ["value"],
      additionalProperties: false,
    });
    expect(projected.diagnostics).toEqual([
      {
        action: "removed",
        keyword: "maxLength",
        path: "/properties/value/maxLength",
        reason: "ollama_grammar_unsupported_post_validated_constraint",
      },
    ]);
  });

  test("fails closed instead of weakening an unacknowledged constraint", () => {
    expect(() =>
      projectOllamaFormat({
        type: "json_schema",
        name: "unacknowledged_bound",
        schema: { type: "string", maxLength: 8 },
      }),
    ).toThrow("ollama_schema_constraint_not_post_validated:/maxLength");
  });

  test("authorizes removal by exact JSON Pointer rather than by keyword", () => {
    expect(() =>
      projectOllamaFormat({
        type: "json_schema",
        name: "partially_acknowledged_bounds",
        postValidatedSchemaConstraints: [
          {
            keyword: "maxLength",
            path: "/properties/allowed/maxLength",
          },
        ],
        schema: {
          type: "object",
          properties: {
            allowed: { type: "string", maxLength: 8 },
            unacknowledged: { type: "string", maxLength: 8 },
          },
        },
      }),
    ).toThrow(
      "ollama_schema_constraint_not_post_validated:/properties/unacknowledged/maxLength",
    );
  });

  test("fails closed when a declared constraint path is stale", () => {
    expect(() =>
      projectOllamaFormat({
        type: "json_schema",
        name: "stale_declaration",
        postValidatedSchemaConstraints: [
          {
            keyword: "maxLength",
            path: "/properties/missing/maxLength",
          },
        ],
        schema: { type: "object", properties: {} },
      }),
    ).toThrow(
      "ollama_post_validated_constraint_not_found:/properties/missing/maxLength",
    );
  });

  test("does not leak projection metadata to OpenAI", () => {
    const format: ModelGatewayJsonSchemaFormat = {
      type: "json_schema",
      name: "portable_output",
      strict: true,
      postValidatedSchemaConstraints: [
        {
          keyword: "maxLength",
          path: "/properties/value/maxLength",
        },
      ],
      schema: {
        type: "object",
        properties: { value: { type: "string", maxLength: 8 } },
      },
    };

    expect(toOpenAIResponsesTextFormat(format)).toEqual({
      type: "json_schema",
      name: "portable_output",
      strict: true,
      schema: {
        type: "object",
        properties: { value: { type: "string", maxLength: 8 } },
      },
    });
  });

  test("supplies the exact schema when OpenAI must use JSON mode for a root union", () => {
    const format: ModelGatewayJsonSchemaFormat = {
      type: "json_schema",
      name: "decision",
      strict: true,
      schema: {
        oneOf: [
          {
            type: "object",
            properties: {
              action: { type: "string", enum: ["respond"] },
            },
            required: ["action"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              action: { type: "string", enum: ["invoke_role"] },
              roleId: { type: "string" },
            },
            required: ["action", "roleId"],
            additionalProperties: false,
          },
        ],
      },
    };

    const projection = projectOpenAIResponsesFormat(format);

    expect(projection.format).toEqual({ type: "json_object" });
    expect(projection.instructions).toHaveLength(1);
    expect(projection.instructions[0]).toContain('"action"');
    expect(projection.instructions[0]).toContain('"invoke_role"');
    expect(projection.instructions[0]).toContain("Do not rename fields");
    expect(projection.diagnostics).toEqual([
      {
        action: "schema_instruction_injected",
        schemaName: "decision",
        reason: "openai_root_union_unsupported",
        instructionCharacterCount: projection.instructions[0]!.length,
      },
    ]);
  });

  test("rejects projection metadata on a non-schema wrapper", () => {
    const malformed = {
      type: "json_object",
      postValidatedSchemaConstraints: [
        { keyword: "maxLength", path: "/maxLength" },
      ],
    };

    expect(() => toOpenAIResponsesTextFormat(malformed)).toThrow(
      "Provider projection metadata requires a valid json_schema format wrapper.",
    );
    expect(() => projectOllamaFormat(malformed)).toThrow(
      "Provider projection metadata requires a valid json_schema format wrapper.",
    );
  });

  test("rejects the legacy format-wide keyword declaration", () => {
    expect(() =>
      projectOllamaFormat({
        type: "json_schema",
        name: "legacy_declaration",
        postValidatedSchemaKeywords: ["maxLength"],
        schema: { type: "object", properties: {} },
      }),
    ).toThrow(
      "Legacy post-validated schema keyword declaration is not accepted for legacy_declaration.",
    );
  });
});
