import { describe, expect, test } from "vitest";

import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

function loadSemanticStatePlugins() {
  const baseline = loadPublicRuntimeConfig(["memory"]);
  return loadConfiguredRuntimePlugins({
    ...baseline,
    plugins: { enabled: true, allow: ["memory"] },
  });
}

describe("semantic state manifest plugin parity", () => {
  test("loads memory tools and action skills exclusively from the manifest", () => {
    const plugin = loadSemanticStatePlugins().find(({ id }) => id === "memory");

    expect(plugin).toMatchObject({
      id: "memory",
      version: "1.0.0",
      capabilitySkills: {
        memory_get: ["memory_lookup_skill"],
        memory_search: ["memory_lookup_skill"],
        memory_add: ["memory_mutation_skill"],
        memory_delete: ["memory_mutation_skill"],
      },
    });
    expect(
      plugin?.capabilities.map(({ definition }) => definition.name),
    ).toEqual(["memory_get", "memory_search", "memory_add", "memory_delete"]);
    expect(
      plugin?.capabilities.flatMap(
        ({ normalInvocation }) =>
          normalInvocation?.operations.map(({ operationId }) => operationId) ??
          [],
      ),
    ).toEqual(["list_memory", "search_memory", "add_memory", "delete_memory"]);
    expect(plugin?.skills?.memory_lookup_skill).toContain(
      "facts actually retrieved",
    );
    expect(plugin?.skills?.memory_mutation_skill).toContain(
      "It is not file storage",
    );
  });
});
