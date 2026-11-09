import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { projectNormalInvocationDefinition } from "../../capabilities/normal-invocation/definition-projection.js";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import { projectAvailableTools } from "../capabilities/tool-availability.js";
import { buildPluginDiscoveryCatalogText } from "../context/capability-descriptions.js";
import { createSkillsContextProvider } from "../context/skills-context.js";
import { projectManifestRuntimeContract } from "../plugins/manifest-projection.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import type { ToolRegistry } from "../ports.js";
import { projectWorkerCapabilitySelectionCatalog } from "../steps/worker-decision/capability-catalog.js";

const pluginRoot = join(process.cwd(), "plugins/web");
const manifestPath = join(pluginRoot, "plugin.json");
const manifest = parseAgentPluginManifest(
  JSON.parse(readFileSync(manifestPath, "utf8")),
  "web",
);
const capabilities = manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities;

function project(capabilityIds = Object.keys(capabilities)) {
  return projectManifestRuntimeContract(
    { pluginRoot, manifestPath, manifest },
    capabilityIds,
  );
}

function registrations(): RegisteredToolNormalInvocation[] {
  return project().capabilities.map(({ definition, normalInvocation }) => ({
    toolName: definition.name,
    definition: {
      ...definition,
      ...projectNormalInvocationDefinition({
        toolName: definition.name,
        contract: normalInvocation,
      }),
    },
    contract: normalInvocation,
  }));
}

function workerProvider() {
  const projection = project();
  const skills = createSkillsContextProvider({
    skills: projection.skills,
    actionSkills: projection.capabilitySkills,
  });
  return createRegisteredToolWorkerCapabilityProvider({
    getRequestToolRegistry: () => ({
      listNormalInvocations: registrations,
    }) as unknown as ToolRegistry,
    requestId: "web-guidance-projection",
    sessionId: "web-guidance-session",
    abortSignal: new AbortController().signal,
    toolPermissionMode: "full_access",
    nextApprovalId: () => "unused",
    loadActionSkillContext: skills.getActionContext,
  });
}

describe("Web plugin guidance projection", () => {
  test("preserves the complete plugin description in compact discovery", () => {
    expect(manifest.description).toBeTruthy();
    expect(Array.from(manifest.description!).length).toBeLessThanOrEqual(160);
    const catalog = buildPluginDiscoveryCatalogText(
      ["web"],
      projectAvailableTools(registrations()),
    );
    expect(catalog).toContain(manifest.description);
    expect(catalog).not.toContain(capabilities.web_fetch!.description);
    expect(catalog).not.toContain("fetch_one");
  });

  test("exposes operation summaries at selection while preserving fetch controls", () => {
    const descriptors = workerProvider().getDescriptors();
    const selection = JSON.stringify(
      projectWorkerCapabilitySelectionCatalog(descriptors).promptPayload,
    );
    expect(descriptors).toHaveLength(4);
    const url = { type: "string", minLength: 1, maxLength: 4096 };
    for (const [operationId, key, value] of [
      ["fetch_one", "url", url],
      ["fetch_many", "urls", {
        type: "array", minItems: 1, maxItems: 3, items: url,
      }],
    ] as const) {
      const declared = capabilities.web_fetch!.operations[operationId]!;
      const descriptor = descriptors.find(
        (entry) => entry.capabilityId === operationId,
      )!;
      expect(descriptor.summary).toBe(declared.summary);
      expect(selection).toContain(JSON.stringify(declared.summary));
      expect(descriptor.effect).toBe("observation");
      expect(declared.approval).toBe("request_policy");
      expect(descriptor.controls).toEqual({
        type: "object",
        additionalProperties: false,
        properties: { [key]: value },
        required: [key],
      });
    }
    expect(selection).not.toContain('"controls"');
    expect(selection).not.toContain("web_fetch_skill");
  });

  test("loads fetch guidance only for the selected capability", () => {
    const fetch = project(["web_fetch"]);
    expect(fetch.capabilities).toHaveLength(1);
    expect(fetch.capabilities[0]!.definition.description).toBe(
      capabilities.web_fetch!.description,
    );
    expect(fetch.capabilitySkills).toEqual({ web_fetch: ["web_fetch_skill"] });
    expect(Object.keys(fetch.skills)).toEqual(["web_fetch_skill"]);
    expect(fetch.skills.web_fetch_skill?.trim()).toBe(
      readFileSync(join(pluginRoot, "skills/web_fetch_skill/SKILL.md"), "utf8").trim(),
    );
    const search = project(["web_search"]);
    expect(search.skills).not.toHaveProperty("web_fetch_skill");
    expect(search.capabilitySkills).toEqual({ web_search: ["web_search_skill"] });
  });

  test("passes the full fetch skill into execution guidance for either fetch operation", async () => {
    const provider = workerProvider();
    const expected = readFileSync(
      join(pluginRoot, "skills/web_fetch_skill/SKILL.md"),
      "utf8",
    ).trim();
    for (const operationId of ["fetch_one", "fetch_many"]) {
      await expect(provider.getExecutionGuidance!(operationId)).resolves.toContain(expected);
    }
    await expect(provider.getExecutionGuidance!("search_one")).resolves.not.toContain(expected);
  });
});
