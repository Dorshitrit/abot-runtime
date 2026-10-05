import { describe, expect, test } from "vitest";
import { parseEventInputTextOptions } from "../tool-definition-validator/event-input-text-options.js";
import {
  projectDeclaredInputText,
  TOOL_EVENT_INPUT_TEXT_MAX_LENGTH,
} from "../tool-event-input-text.js";

describe("declared input text bounds", () => {
  test("validation and projection agree at the maximum permitted length", () => {
    const options = parseEventInputTextOptions(
      {
        kind: "string",
        maxLength: TOOL_EVENT_INPUT_TEXT_MAX_LENGTH,
        preserveWhitespace: true,
      },
      "field",
    );
    const input = " " + "x".repeat(TOOL_EVENT_INPUT_TEXT_MAX_LENGTH - 2) + " ";
    expect(
      projectDeclaredInputText(input, {
        param: "input",
        kind: "string",
        ...options,
      }),
    ).toEqual({ text: input, truncated: false });
    expect(() =>
      parseEventInputTextOptions(
        { kind: "string", maxLength: TOOL_EVENT_INPUT_TEXT_MAX_LENGTH + 1 },
        "field",
      ),
    ).toThrow();
  });

  test("keeps existing defaults and narrower opt-in limits", () => {
    expect(
      projectDeclaredInputText("x".repeat(501), {
        param: "input",
        kind: "string",
      }),
    ).toEqual({ text: "x".repeat(500), truncated: true });
    expect(
      projectDeclaredInputText("12345", {
        param: "input",
        kind: "string",
        maxLength: 4,
      }),
    ).toEqual({ text: "1234", truncated: true });
  });

  test("cannot split a surrogate pair at the expanded bound", () => {
    const prefix = "x".repeat(TOOL_EVENT_INPUT_TEXT_MAX_LENGTH - 1);
    expect(
      projectDeclaredInputText(prefix + "\u{1F680}", {
        param: "input",
        kind: "string",
        maxLength: TOOL_EVENT_INPUT_TEXT_MAX_LENGTH,
      }),
    ).toEqual({ text: prefix, truncated: true });
  });
});
