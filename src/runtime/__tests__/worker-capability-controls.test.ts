import { describe, expect, test } from "vitest";

import {
  normalizeWorkerCapabilityControlsSchema,
  validateWorkerCapabilityAcceptedControls,
  validateWorkerCapabilityControls,
} from "../orchestration/worker-capabilities/index.js";

describe("Worker capability controls", () => {
  test("accepts an unbounded string value beyond 4096 while preserving a bounded sibling", () => {
    const normalized = normalizeWorkerCapabilityControlsSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1 },
        cwd: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      required: ["command", "cwd"],
    });

    expect(normalized).toMatchObject({
      ok: true,
      value: {
        properties: {
          command: { type: "string", minLength: 1 },
          cwd: { type: "string", minLength: 1, maxLength: 4_096 },
        },
      },
    });
    if (!normalized.ok) throw new Error(normalized.issueCode);

    const longCommand = `printf '%s' '${"x".repeat(4_096)}'`;
    expect(longCommand.length).toBeGreaterThan(4_096);
    expect(
      validateWorkerCapabilityControls(normalized.value, {
        command: longCommand,
        cwd: ".",
      }),
    ).toEqual({
      ok: true,
      value: { command: longCommand, cwd: "." },
    });

    expect(
      validateWorkerCapabilityControls(normalized.value, {
        command: longCommand,
        cwd: "x".repeat(4_097),
      }),
    ).toEqual({
      ok: false,
      issueCode: "controls_string_invalid",
      controlId: "cwd",
    });
  });

  test("requires the unbounded string schema to use its exact two-key shape", () => {
    expect(
      normalizeWorkerCapabilityControlsSchema({
        type: "object",
        additionalProperties: false,
        properties: {
          command: {
            type: "string",
            minLength: 1,
            description: "not part of the control contract",
          },
        },
        required: ["command"],
      }),
    ).toEqual({
      ok: false,
      issueCode: "controls_schema_string_invalid",
    });
  });

  test("captures adapter-validated staged controls outside the public descriptor", () => {
    const result = validateWorkerCapabilityAcceptedControls({
      path: "target.txt",
      selection: '{"placement":"replace","start_line":1,"end_line":1}',
      lineBounds: [1, 1],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        path: "target.txt",
        selection: '{"placement":"replace","start_line":1,"end_line":1}',
        lineBounds: [1, 1],
      },
    });
    if (!result.ok) throw new Error(result.issueCode);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.lineBounds)).toBe(true);
  });

  test("rejects a prepared action outside the shared flat controls envelope", () => {
    expect(
      validateWorkerCapabilityAcceptedControls({
        selection: { placement: "replace" },
      }),
    ).toEqual({
      ok: false,
      issueCode: "accepted_controls_value_invalid",
      controlId: "selection",
    });
  });
});
