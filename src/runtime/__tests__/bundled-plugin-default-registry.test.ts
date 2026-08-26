import { describe, expect, test } from "vitest";

import { createDefaultToolRegistry } from "../default-adapters.js";

describe("bundled plugin default registry", () => {
  test("discovers manifest-owned capabilities without explicit runtime config", () => {
    const registry = createDefaultToolRegistry();

    expect(registry.getDefinition("system_probe")?.name).toBe("system_probe");
    expect(registry.getImplementations().system_probe).toBeTypeOf("function");
    expect(
      registry
        .listNormalInvocations?.()
        .find(({ toolName }) => toolName === "system_probe")
        ?.contract.operations.map(({ operationId }) => operationId),
    ).toEqual(["inspect_system_state", "inspect_disk_state_for_path"]);
  });
});
