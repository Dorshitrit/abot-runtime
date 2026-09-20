import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseToolDefinition } from "../../capabilities/tool-definition-validator.js";
import { buildToolStartEventMetadata } from "../../capabilities/tool-event-metadata.js";
import type { ToolDefinition } from "../../capabilities/tool-types.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";

function moduleDefinition(options: Record<string, unknown>) {
  return parseToolDefinition({
    name: "custom_process",
    routingCapability: "filesystem_inspection",
    params: { command: "string" },
    eventPresentation: {
      metadata: { command: { param: "command", kind: "string", ...options } },
    },
  });
}

function manifestDefinition(options: Record<string, unknown>) {
  const raw = JSON.parse(readFileSync("plugins/system/plugin.json", "utf8"));
  raw.extensions[
    "ai.abot.runtime"
  ].capabilities.system_command.eventPresentation.metadata.command = {
    param: "command",
    kind: "string",
    ...options,
  };
  return parseAgentPluginManifest(raw, "system").extensions["ai.abot.runtime"]
    .capabilities.system_command!.eventPresentation;
}

function metadata(text: string, options: Record<string, unknown> = {}) {
  const definition: ToolDefinition = {
    ...moduleDefinition(options),
    executionEffect: "mixed",
  };
  return buildToolStartEventMetadata(
    { tool: "custom_process", params: { command: text } },
    definition,
  );
}

describe("declared input text display options", () => {
  test("preserves the exact opt-in command at the operation's 4096-character limit", () => {
    const command = ` \n${"x".repeat(4_092)}\n `;
    expect(command).toHaveLength(4_096);
    expect(
      metadata(command, { maxLength: 4_096, preserveWhitespace: true }),
    ).toEqual({
      command,
      commandTruncated: false,
    });
  });

  test("leaves existing 500-character trimmed string summaries unchanged", () => {
    expect(metadata(`  ${"x".repeat(510)}  `)).toEqual({
      command: `${"x".repeat(497)}...`,
    });
    expect(metadata("  printf ok\n")).toEqual({ command: "printf ok" });
  });

  test("length and whitespace controls are independent and explicit", () => {
    expect(metadata(" 12345 ", { maxLength: 4 })).toEqual({
      command: "1234",
      commandTruncated: true,
    });
    expect(metadata(" 123 ", { preserveWhitespace: true })).toEqual({
      command: " 123 ",
      commandTruncated: false,
    });
    expect(
      metadata(" 123 ", { maxLength: 5, preserveWhitespace: false }),
    ).toEqual({
      command: "123",
      commandTruncated: false,
    });
  });

  test("clipping never splits a Unicode surrogate pair", () => {
    expect(
      metadata("a😀z", { maxLength: 2, preserveWhitespace: true }),
    ).toEqual({
      command: "a",
      commandTruncated: true,
    });
    expect(metadata("😀", { maxLength: 2 })).toEqual({
      command: "😀",
      commandTruncated: false,
    });
  });

  test("explicit string defaults are bounded by the same declared contract", () => {
    const definition: ToolDefinition = {
      ...moduleDefinition({ maxLength: 3, default: "long default" }),
      executionEffect: "mixed",
    };
    expect(
      buildToolStartEventMetadata(
        { tool: "custom_process", params: {} },
        definition,
      ),
    ).toEqual({
      command: "lon",
      commandTruncated: true,
    });
  });

  test.each([0, -1, 4_097, 1.5, NaN, Infinity, "4096", null])(
    "both declaration entry points reject maxLength=%s",
    (maxLength) => {
      expect(() => moduleDefinition({ maxLength })).toThrow(/maxLength/);
      expect(() => manifestDefinition({ maxLength })).toThrow(/maxLength/);
    },
  );

  test.each([0, "true", null])(
    "both entry points reject preserveWhitespace=%s",
    (preserveWhitespace) => {
      expect(() => moduleDefinition({ preserveWhitespace })).toThrow(
        /preserveWhitespace/,
      );
      expect(() => manifestDefinition({ preserveWhitespace })).toThrow(
        /preserveWhitespace/,
      );
    },
  );

  test.each(["number", "length", "string_array", "boolean"])(
    "text options cannot decorate %s projections",
    (kind) => {
      expect(() => moduleDefinition({ kind, maxLength: 100 })).toThrow(
        /kind string/,
      );
      expect(() => manifestDefinition({ kind, maxLength: 100 })).toThrow(
        /kind string/,
      );
    },
  );

  test.each([true, false])(
    "both entry points accept boolean projections and preserve %s",
    (value) => {
      const options = { kind: "boolean" };
      const definition: ToolDefinition = {
        ...moduleDefinition(options),
        executionEffect: "mixed",
      };
      expect(definition.eventPresentation?.metadata.command).toEqual(
        manifestDefinition(options)?.metadata.command,
      );
      expect(
        buildToolStartEventMetadata(
          { tool: "custom_process", params: { command: value } },
          definition,
        ),
      ).toEqual({ command: value });
    },
  );

  test.each(["true", 1, null])(
    "boolean projections do not coerce %s",
    (value) => {
      const definition: ToolDefinition = {
        ...moduleDefinition({ kind: "boolean" }),
        executionEffect: "mixed",
      };
      const projected = buildToolStartEventMetadata(
        { tool: "custom_process", params: { command: value } },
        definition,
      );
      expect(projected).not.toHaveProperty("command");
      const withDefault: ToolDefinition = {
        ...moduleDefinition({ kind: "boolean", default: false }),
        executionEffect: "mixed",
      };
      expect(
        buildToolStartEventMetadata(
          { tool: "custom_process", params: { command: value } },
          withDefault,
        ),
      ).toEqual({ command: false });
    },
  );

  test("opt-in string arrays preserve empty arguments, whitespace and positions", () => {
    const options = { kind: "string_array", preserveWhitespace: true };
    const definition: ToolDefinition = {
      ...moduleDefinition(options),
      executionEffect: "mixed",
    };
    expect(definition.eventPresentation?.metadata.command).toEqual(
      manifestDefinition(options)?.metadata.command,
    );
    expect(
      buildToolStartEventMetadata(
        {
          tool: "custom_process",
          params: { command: ["", " value ", "last"] },
        },
        definition,
      ),
    ).toEqual({
      command: ["", " value ", "last"],
      commandTruncated: false,
      commandOmittedCount: 0,
    });
  });

  test("opted-in argument arrays explicitly report count and character clipping", () => {
    const definition: ToolDefinition = {
      ...moduleDefinition({ kind: "string_array", preserveWhitespace: true }),
      executionEffect: "mixed",
    };
    const values = [
      "x".repeat(510),
      ...Array.from({ length: 33 }, () => "next"),
    ];
    const display = buildToolStartEventMetadata(
      { tool: "custom_process", params: { command: values } },
      definition,
    )!;
    expect(display.command).toEqual([
      "x".repeat(500),
      ...Array.from({ length: 31 }, () => "next"),
    ]);
    expect(display).toMatchObject({
      commandTruncated: true,
      commandOmittedCount: 2,
    });
  });

  test("legacy arrays keep their existing normalization", () => {
    const definition: ToolDefinition = {
      ...moduleDefinition({ kind: "string_array" }),
      executionEffect: "mixed",
    };
    expect(
      buildToolStartEventMetadata(
        { tool: "custom_process", params: { command: ["", " value "] } },
        definition,
      ),
    ).toEqual({ command: ["value"] });
  });

  test("both declaration paths retain the same opted-in descriptor", () => {
    const options = { maxLength: 4_096, preserveWhitespace: true };
    expect(
      moduleDefinition(options).eventPresentation?.metadata.command,
    ).toEqual(manifestDefinition(options)?.metadata.command);
  });
});
