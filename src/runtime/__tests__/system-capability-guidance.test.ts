import { describe, expect, test } from "vitest";
import { discoverAgentPluginManifests } from "../plugins/manifest-discovery.js";
import { projectManifestRuntimeContract } from "../plugins/manifest-projection.js";

const system = discoverAgentPluginManifests(process.cwd()).find(
  (plugin) => plugin.manifest.name === "system",
)!;
const common = "system_actions";
const guidance = [
  ["system_targets", [common]],
  ["system_command", [common, "system_commands"]],
  ["system_applications", [common, "system_applications"]],
  ["system_launch", [common, "system_applications"]],
  ["computer_desktops", [common, "computer_desktop"]],
  ["computer_observe", [common, "computer_desktop"]],
  ["computer_act", [common, "computer_desktop"]],
] as const;

describe("SYSTEM action guidance selection", () => {
  test.each(guidance)("%s exposes only its relevant packaged guides", (id, skills) => {
    const projected = projectManifestRuntimeContract(system, [id]);
    expect(projected.capabilities).toHaveLength(1);
    expect(projected.capabilities[0]!.definition.executionPolicies).toEqual(["execution-agent-v1"]);
    expect(projected.capabilitySkills).toEqual({ [id]: skills });
    expect(Object.keys(projected.skills).sort()).toEqual([...skills].sort());
    expect(Object.values(projected.skills).every((text) => text.trim().length > 0)).toBe(true);
    // Bound the complete selected guidance, not any literal instruction wording.
    expect(Object.values(projected.skills).join("\n").length).toBeLessThan(7_000);
  });

  test("combining capabilities loads the shared guide once", () => {
    const projected = projectManifestRuntimeContract(system, ["system_command", "system_launch"]);
    expect(Object.keys(projected.skills).sort()).toEqual([
      "system_actions", "system_applications", "system_commands",
    ]);
    expect(projected.capabilitySkills.system_command).not.toContain("computer_desktop");
    expect(projected.capabilitySkills.system_launch).not.toContain("computer_desktop");
  });

  test("excluding SYSTEM capabilities provides no computer guidance", () => {
    const projected = projectManifestRuntimeContract(system, []);
    expect(projected.capabilities).toEqual([]);
    expect(projected.capabilitySkills).toEqual({});
    expect(projected.skills).toEqual({});
  });
});
