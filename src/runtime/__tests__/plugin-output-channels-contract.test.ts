import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseToolNormalInvocationContract } from "../../capabilities/normal-invocation/validator.js";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";

function manifestWithChannels(outputChannels: unknown) {
  const manifest = JSON.parse(readFileSync("plugins/web/plugin.json", "utf8"));
  const operation = manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities.web_search.operations.search_one;
  delete operation.outputChannels;
  if (outputChannels !== undefined) operation.outputChannels = outputChannels;
  return { manifest, operation };
}

function parseBothBoundaries(outputChannels: unknown) {
  const { manifest, operation } = manifestWithChannels(outputChannels);
  const normal = parseToolNormalInvocationContract("web_search", {
    version: 1, operations: [{ operationId: "search_one", ...operation }],
  })!;
  const parsed = parseAgentPluginManifest(manifest, "web");
  return [normal.operations[0]!, parsed.extensions[ABOT_RUNTIME_EXTENSION]
    .capabilities.web_search!.operations.search_one!];
}

describe("output channel declaration contract", () => {
  it.each(["content", "metadata", "conditional"] as const)("preserves %s and detaches frozen values", (role) => {
    const channels = { text: role, data: role };
    for (const operation of parseBothBoundaries(channels)) {
      expect(operation.outputChannels).toEqual(channels);
      expect(operation.outputChannels).not.toBe(channels);
      expect(Object.isFrozen(operation.outputChannels)).toBe(true);
    }
  });

  it("leaves legacy undeclared channels absent without adding a default", () => {
    for (const operation of parseBothBoundaries(undefined))
      expect(operation).not.toHaveProperty("outputChannels");
  });

  it.each([
    { name: "null", value: null },
    { name: "array", value: ["content", "metadata"] },
    { name: "missing text", value: { data: "metadata" } },
    { name: "missing data", value: { text: "content" } },
    { name: "unknown role", value: { text: "content", data: "unknown" } },
    { name: "wrong role type", value: { text: true, data: "metadata" } },
    { name: "free text", value: { text: "x".repeat(4096), data: "metadata" } },
    { name: "extra channel", value: { text: "content", data: "metadata", stdout: "content" } },
    { name: "extra pointer schema", value: { text: "content", data: "content", dataPointers: {} } },
  ])("rejects $name at both registration boundaries", ({ value }) => {
    const { manifest, operation } = manifestWithChannels(value);
    expect(() => parseToolNormalInvocationContract("web_search", {
      version: 1, operations: [{ operationId: "search_one", ...operation }],
    })).toThrow(/outputChannels/u);
    expect(() => parseAgentPluginManifest(manifest, "web")).toThrow(/outputChannels/u);
  });
});
