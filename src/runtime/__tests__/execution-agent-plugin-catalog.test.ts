import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolAvailabilityEntry, ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { successResult } from "../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  buildExecutionCapabilityGroupCatalogMessage,
  EXECUTION_CAPABILITY_GROUP_CATALOG_HEADER as GROUP_HEADER,
} from "../steps/execution-agent/plugin-catalog.js";
import {
  capsules, decision, filesystemScopeFixture, messages, type FilesystemModelInput,
} from "./support/filesystem-scope-integration-fixture.js";

const DESCRIPTION = "Discover applications and control the connected desktop.";
const SUMMARY = "Inspect the exact opaque item selected by itemId.";
const ACTIVE_KIND = "runtime_execution_capability_catalog_v1";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function entry(operationId: string, metadata: Partial<ToolAvailabilityEntry> = {}): ToolAvailabilityEntry {
  return {
    toolName: "desktop_tools", operationId, summary: SUMMARY,
    catalogGroups: ["desktop"], effect: "read_only",
    pluginName: "dynamic-desktop", pluginDescription: DESCRIPTION, ...metadata,
  };
}

describe("EA plugin discovery catalog", () => {
  it("binds each tool to its exact offered groups and each description to its plugin", () => {
    const catalog = buildExecutionCapabilityGroupCatalogMessage(
      ["unknown-provider", "read", "native-only", "desktop"],
      [
        entry("observe", { toolName: "inspect_desktop", catalogGroups: ["read", "desktop", "unoffered"] }),
        entry("observe_again", { toolName: "inspect_desktop", catalogGroups: ["desktop", "read"] }),
        entry("click", { toolName: "click_item", catalogGroups: ["desktop"] }),
        entry("inspect", { toolName: "read_file", pluginName: "another-plugin", pluginDescription: "Inspect project files.", catalogGroups: ["read"] }),
        entry("native", { toolName: "native_inspect", pluginName: undefined, pluginDescription: "No fabricated native owner.", catalogGroups: ["read", "native-only"] }),
        entry("hidden_tool", { toolName: "unoffered_tool", catalogGroups: ["unoffered"] }),
        entry("hidden", { pluginName: "unoffered-plugin", catalogGroups: ["unoffered"] }),
      ],
    );
    expect(catalog).toEqual({ role: "user", content:
      `${GROUP_HEADER} desktop: dynamic-desktop [click_item, inspect_desktop] | native-only: native_inspect | read: native_inspect, another-plugin [read_file], dynamic-desktop [inspect_desktop] | unknown-provider\nPlugin descriptions: another-plugin: Inspect project files. | dynamic-desktop: ${DESCRIPTION}`,
    });
    expect(catalog.content.split(DESCRIPTION)).toHaveLength(2);
    expect(catalog.content).not.toContain(SUMMARY);
    expect(catalog.content).not.toContain("unoffered");
    expect(catalog.content).not.toContain("No fabricated native owner.");
  });

  it("keeps description pipes separate from actual catalog entry delimiters", () => {
    const description = "Reads files | helper [write] Modifies files || more";
    const offeredEntry = entry("read", { pluginDescription: description });
    const catalog = buildExecutionCapabilityGroupCatalogMessage(["desktop", "read"], [
      offeredEntry,
      entry("inspect", { pluginName: "another-plugin", pluginDescription: "Inspect files.", catalogGroups: ["read"] }),
    ]);
    expect(catalog.content.split("\n")).toEqual([
      `${GROUP_HEADER} desktop: dynamic-desktop [desktop_tools] | read: another-plugin [desktop_tools]`,
      "Plugin descriptions: another-plugin: Inspect files. | dynamic-desktop: Reads files / helper [write] Modifies files // more",
    ]);
    expect(catalog.content.split("\n")[1]!.split(" | ")).toHaveLength(2);
    expect(offeredEntry.pluginDescription).toBe(description);
  });

  it("escapes tool-name delimiters without changing canonical names", () => {
    const toolName = "write|file;[next],: %\\\n";
    const offeredEntry = entry("write", { toolName, pluginDescription: undefined });
    const catalog = buildExecutionCapabilityGroupCatalogMessage(["desktop", "read"], [
      offeredEntry,
      entry("inspect", { toolName: "read_file", pluginName: "another-plugin", pluginDescription: undefined, catalogGroups: ["read"] }),
    ]);
    expect(catalog.content.split(" | ")).toEqual([
      `${GROUP_HEADER} desktop: dynamic-desktop [write%7Cfile%3B%5Bnext%5D%2C%3A%20%25%5C%0A]`,
      "read: another-plugin [read_file]",
    ]);
    expect(catalog.content).not.toContain("\n");
    expect(offeredEntry.toolName).toBe(toolName);
  });

  it("retains legacy IDs without entries and exposes native tools without plugin metadata", () => {
    expect(buildExecutionCapabilityGroupCatalogMessage(["read", "write"]))
      .toEqual({ role: "user", content: `${GROUP_HEADER} read, write` });
    expect(buildExecutionCapabilityGroupCatalogMessage(["read"], [entry("read", {
      pluginName: undefined, pluginDescription: undefined, catalogGroups: ["read"],
    })]).content).toBe(`${GROUP_HEADER} read: desktop_tools`);
    expect(buildExecutionCapabilityGroupCatalogMessage(["desktop"], [entry("read", {
      pluginDescription: undefined,
    })]).content).toBe(`${GROUP_HEADER} desktop: dynamic-desktop [desktop_tools]`);
    expect(buildExecutionCapabilityGroupCatalogMessage(["write", "read"], [entry("hidden")]).content)
      .toBe(`${GROUP_HEADER} write, read`);
  });

  it.each([undefined, "", "  \n\t"])(
    "takes a later description once when the first plugin entry has no description (%j)",
    (missingDescription) => {
      const catalog = buildExecutionCapabilityGroupCatalogMessage(["desktop", "read"], [
        entry("first", { pluginDescription: missingDescription }),
        entry("later", { pluginDescription: "Read files.", catalogGroups: ["read"] }),
        entry("last", { pluginDescription: "Different description." }),
      ]);
      expect(catalog.content).toBe(`${GROUP_HEADER} desktop: dynamic-desktop [desktop_tools] | read: dynamic-desktop [desktop_tools]\nPlugin descriptions: dynamic-desktop: Read files.`);
    },
  );

  it.each([
    ["", ""],
    ["a".repeat(160), "a".repeat(160)],
    ["a".repeat(161), `${"a".repeat(160)}....`],
    ["|".repeat(161), `${"/".repeat(160)}....`],
    ["😀".repeat(161), `${"😀".repeat(160)}....`],
    [`  ${"a".repeat(159)}\n\tbc  `, `${"a".repeat(159)} ....`],
  ])("bounds only the EA description preview for %j", (description, preview) => {
    const offeredEntry = entry("observe", { pluginDescription: description });
    const catalog = buildExecutionCapabilityGroupCatalogMessage(["desktop"], [offeredEntry]);
    const identity = `${GROUP_HEADER} desktop: dynamic-desktop [desktop_tools]`;
    expect(catalog.content).toBe(preview ? `${identity}\nPlugin descriptions: dynamic-desktop: ${preview}` : identity);
    expect(offeredEntry.pluginDescription).toBe(description);
  });

  it("deduplicates operations of one tool and keeps descriptions on one line", () => {
    const catalogs = [1, 78].map((count) => buildExecutionCapabilityGroupCatalogMessage(
      ["desktop", "read"],
      Array.from({ length: count }, (_, index) => entry(`operation_${index}`, {
        pluginDescription: "Discover applications.\n\tControl desktops.",
        catalogGroups: ["read", "desktop"],
      })),
    ));
    expect(catalogs[0]).toEqual(catalogs[1]);
    expect(catalogs[0]!.content).toBe(
      `${GROUP_HEADER} desktop: dynamic-desktop [desktop_tools] | read: dynamic-desktop [desktop_tools]\nPlugin descriptions: dynamic-desktop: Discover applications. Control desktops.`,
    );
  });

  it("projects request-effective plugin discovery only to EA decisions while existing scope opening reveals operations", async () => {
    const fixture = await filesystemScopeFixture("execution-agent-v1");
    const execute = vi.fn<ToolModuleDeclaration["implementation"]>(async () =>
      successResult({ output: "The exact selected fixture item was observed." }),
    );
    const registry = createConfiguredToolRegistry(fixture.config, [{
      definition: {
        name: "desktop_tools", pluginName: "dynamic-desktop", pluginDescription: DESCRIPTION,
        routingCapability: "semantic_lookup", catalogGroups: ["desktop", "read"],
      },
      normalInvocation: {
        version: 1,
        operations: [{
          operationId: "inspect_opaque_item", summary: SUMMARY,
          effect: "read_only", approval: "request_policy",
          input: {
            type: "object", additionalProperties: false,
            properties: { itemId: { type: "string", minLength: 1, maxLength: 80 } },
            required: ["itemId"],
          },
        }],
      },
      implementation: execute,
    }]);
    const inputs: FilesystemModelInput[] = [];
    const scripted = fixture.script([
      { step: "execution.decision", output: decision({
        action: "open_capability_scope", catalogGroupIds: ["desktop"],
        acknowledgement: "I will inspect the selected item.",
      }) },
      { step: "execution.decision", output: decision({
        action: "invoke_capability", capabilityId: "inspect_opaque_item",
        intent: "Inspect the selected item.", operationObjective: "Inspect fixture-item.",
        controlsEvidenceExecutionIds: [], workingDirectory: ".",
      }) },
      { step: "capability.controls", output: decision({ invocations: {
        invocation_1: { disposition: "execute", controls: { itemId: "fixture-item" } },
      } }) },
      { step: "execution.decision", output: decision({ action: "respond" }) },
      { step: "execution.response", output: "The selected item was observed." },
    ], (input) => inputs.push(input));
    try {
      await fixture.run(scripted.model, registry);
      scripted.assertComplete();
      const initial = inputs[0]!;
      const initialProjection = JSON.stringify({ messages: messages(initial), format: initial.format });
      expect(initialProjection).toContain("desktop: dynamic-desktop [desktop_tools] | read: dynamic-desktop [desktop_tools]");
      expect(initialProjection).toContain(DESCRIPTION);
      expect(initialProjection).not.toContain(SUMMARY);
      expect(initialProjection).not.toContain("inspect_opaque_item");
      expect(initialProjection).not.toContain("itemId");
      expect(capsules(initial, ACTIVE_KIND)).toEqual([]);
      const opened = inputs[1]!;
      expect(capsules(opened, ACTIVE_KIND)).toEqual([expect.objectContaining({
        capabilities: [{ capabilityId: "inspect_opaque_item", summary: SUMMARY, effect: "observation" }],
      })]);
      expect(JSON.stringify(inputs[2]!.format)).toContain("itemId");
      for (const input of inputs) {
        const catalog = messages(input).filter(({ content }) => content.startsWith(GROUP_HEADER));
        if (input.modelStep === "execution.decision") {
          expect(catalog).toEqual([{ role: "user", content:
            `${GROUP_HEADER} desktop: dynamic-desktop [desktop_tools] | read: dynamic-desktop [desktop_tools]\nPlugin descriptions: dynamic-desktop: ${DESCRIPTION}` }]);
          expect(messages(input).map(({ content }) => content).join("\n").split(DESCRIPTION)).toHaveLength(2);
          continue;
        }
        expect(catalog).toEqual([]);
        expect(JSON.stringify({ messages: messages(input), format: input.format })).not.toContain(DESCRIPTION);
      }
      expect(execute).toHaveBeenCalledExactlyOnceWith({ itemId: "fixture-item" }, expect.anything());
    } finally {
      await fixture.close();
    }
  });
});
