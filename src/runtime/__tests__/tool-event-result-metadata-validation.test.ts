import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { parseEventResultMetadata } from "../../capabilities/tool-definition-validator/event-result-metadata.js";
import { parseEventPresentation } from "../../capabilities/tool-definition-validator/event-presentation.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";

const PROJECTION = { outputPreview: { path: "output", kind: "preview" } };

describe("result presentation declaration validation", () => {
  test.each([
    "filesystem",
    "memory",
    "local-search",
    "project-orientation",
    "json-inspector",
    "code-outline",
    "document-reader",
  ])("accepts packaged %s declarations through both validators", (name) => {
    const raw = JSON.parse(readFileSync(`plugins/${name}/plugin.json`, "utf8"));
    const manifest = parseAgentPluginManifest(raw, name);
    const capabilities = manifest.extensions["ai.abot.runtime"].capabilities;
    for (const [capabilityId, capability] of Object.entries(capabilities)) {
      if (!capability.eventPresentation) continue;
      expect(
        parseEventPresentation(capabilityId, capability.eventPresentation),
      ).toEqual(capability.eventPresentation);
    }
  });

  test("keeps old presentation declarations unchanged", () => {
    const legacy = { metadata: { path: { param: "path", kind: "string" } } };
    expect(parseEventPresentation("reader", legacy)).toEqual(legacy);
  });

  test("passes a valid result declaration through the definition parser", () => {
    expect(
      parseEventPresentation("reader", {
        metadata: {},
        resultMetadata: PROJECTION,
      }),
    ).toEqual({ metadata: {}, resultMetadata: PROJECTION });
  });

  test.each([
    null,
    [],
    { outputPreview: { path: "output", kind: "string" } },
    { outputPreview: { path: "params.content", kind: "preview" } },
    { outputPreview: { path: "data.__proto__.value", kind: "preview" } },
    { outputPreview: { path: "data.constructor.name", kind: "preview" } },
    { outputPreview: { path: "data.a.b.c.d", kind: "preview" } },
    { outputPreview: { path: "data", kind: "preview" } },
    { outputPreview: { path: "output", kind: "preview", maxChars: 1_000_000 } },
    {
      outputPreview: { path: "output", kind: "preview" },
      outputPreviewTruncated: { path: "data.truncated", kind: "boolean" },
    },
    Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `p${index}`,
        { path: "output", kind: "preview" },
      ]),
    ),
  ])("rejects invalid mappings in the shared validator: %j", (value) => {
    expect(() => parseEventResultMetadata(value, "resultMetadata")).toThrow();
    expect(() =>
      parseEventPresentation("reader", { metadata: {}, resultMetadata: value }),
    ).toThrow();
    const raw = JSON.parse(readFileSync("plugins/memory/plugin.json", "utf8"));
    raw.extensions[
      "ai.abot.runtime"
    ].capabilities.memory_get.eventPresentation.resultMetadata = value;
    expect(() => parseAgentPluginManifest(raw, "memory")).toThrow();
  });
});
