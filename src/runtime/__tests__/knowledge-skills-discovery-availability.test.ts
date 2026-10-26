import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import { projectDiscoverableSkills } from "../knowledge-skills/discovery-availability.js";
import { createRuntimeKnowledgeSkillStore } from "../knowledge-skills/personal-store.js";
import { createKnowledgeSkillStore } from "../knowledge-skills/store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const general = { skillId: "general-guide", name: "General guide", description: "General conventions.", content: "GENERAL_BODY" };
const alpha = { skillId: "alpha-guide", name: "Alpha guide", description: "Alpha procedure.", content: "ALPHA_BODY" };
const beta = { skillId: "beta-guide", name: "Beta guide", description: "Beta procedure.", content: "BETA_BODY" };
const alphaRequirements = [
  { toolName: "alpha", operationId: "search" },
  { toolName: "alpha", operationId: "read" },
];
const betaRequirements = [{ toolName: "beta", operationId: "search" }];

function tool(toolName: string, operationId: string): ToolAvailabilityEntry {
  return { toolName, operationId, summary: "Fixture operation", catalogGroups: ["knowledge"], effect: "read_only" };
}

function discoveryStore() {
  return createKnowledgeSkillStore([
    general,
    { ...alpha, discovery: { requiredOperations: alphaRequirements } },
    { ...beta, discovery: { requiredOperations: betaRequirements } },
  ]);
}

function skillIds(tools: readonly ToolAvailabilityEntry[]) {
  return projectDiscoverableSkills(discoveryStore(), tools).map(({ skillId }) => skillId);
}

test("declarative discovery requires every exact tool and operation pair for each independent Skill", () => {
  expect(skillIds([])).toEqual([general.skillId]);
  expect(skillIds([tool("alpha", "search")])).toEqual([general.skillId]);
  expect(skillIds([tool("alpha", "search"), tool("beta", "read")])).toEqual([general.skillId]);
  expect(skillIds([tool("alpha", "search"), tool("alpha", "search")])).toEqual([general.skillId]);
  expect(skillIds([tool("alpha", "search"), tool("alpha", "read")])).toEqual([general.skillId, alpha.skillId]);
  expect(skillIds([tool("beta", "search")])).toEqual([general.skillId, beta.skillId]);
  expect(skillIds([tool("alpha", "search"), tool("alpha", "read"), tool("beta", "search")]))
    .toEqual([general.skillId, alpha.skillId, beta.skillId]);
});

test("discovery metadata is isolated from caller mutations and does not change explicit LIST or READ", () => {
  const requirements = alphaRequirements.map(entry => ({ ...entry }));
  const store = createKnowledgeSkillStore([{ ...alpha, discovery: { requiredOperations: requirements } }]);
  const metadata = { skillId: alpha.skillId, name: alpha.name, description: alpha.description };
  expect(store.list()).toEqual([metadata]);
  expect(store.read(alpha.skillId)).toEqual(alpha);
  expect(store.getDiscoveryRequirements?.(alpha.skillId)).toEqual(alphaRequirements);
  requirements[0]!.toolName = "changed";
  requirements.push({ toolName: "other", operationId: "write" });
  const captured = store.getDiscoveryRequirements!(alpha.skillId)!;
  expect(captured).toEqual(alphaRequirements);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Object.isFrozen(captured[0])).toBe(true);
  expect(Reflect.set(captured[0]!, "operationId", "changed")).toBe(false);
  expect(projectDiscoverableSkills(store, [])).toEqual([]);
  expect(store.list()).toEqual([metadata]);
  expect(store.read(alpha.skillId)).toEqual(alpha);
  expect(store.getDiscoveryRequirements?.("unknown")).toBeUndefined();
});

test("automatic discovery sanitizes metadata without loading any Skill body", () => {
  const source = discoveryStore();
  const read = vi.fn(source.read);
  const store = { ...source, read, list: () => source.list().map(metadata => ({
    ...metadata, content: "BODY_MUST_NOT_BE_LOADED", discovery: { internal: "NOT_MODEL_METADATA" },
  })) };
  expect(projectDiscoverableSkills(store, [tool("beta", "search")])).toEqual([
    { skillId: general.skillId, name: general.name, description: general.description },
    { skillId: beta.skillId, name: beta.name, description: beta.description },
  ]);
  expect(read).not.toHaveBeenCalled();
});

test("legacy Stores without discovery requirements retain their metadata and never require a body read", () => {
  const read = vi.fn();
  const store = { list: () => [alpha, general], read };
  expect(projectDiscoverableSkills(store, [])).toEqual([
    { skillId: alpha.skillId, name: alpha.name, description: alpha.description },
    { skillId: general.skillId, name: general.name, description: general.description },
  ]);
  expect(read).not.toHaveBeenCalled();
});

test("the personal Store forwards system discovery requirements without changing stored or explicitly read documents", async () => {
  const base = join(process.cwd(), ".codex", "artifacts", "information-basket-skill-discovery-20261025", "tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  roots.push(root);
  const system = discoveryStore();
  const read = vi.fn(system.read);
  const store = createRuntimeKnowledgeSkillStore(root, { ...system, read });
  const personal = await store.create({ name: "Personal guide", description: "Personal conventions.", content: "PERSONAL_BODY" });
  read.mockClear();
  expect(store.getDiscoveryRequirements?.(alpha.skillId)).toEqual(alphaRequirements);
  expect(store.getDiscoveryRequirements?.(personal.skillId)).toBeUndefined();
  expect(projectDiscoverableSkills(store, []).map(({ skillId }) => skillId)).toEqual([general.skillId, personal.skillId]);
  expect(projectDiscoverableSkills(store, [tool("beta", "search")]).map(({ skillId }) => skillId))
    .toEqual([general.skillId, beta.skillId, personal.skillId]);
  expect(read).not.toHaveBeenCalled();
  expect(store.list().find(({ skillId }) => skillId === alpha.skillId)).toEqual({
    skillId: alpha.skillId, name: alpha.name, description: alpha.description, source: "system",
  });
  expect(store.read(alpha.skillId)).toEqual({ ...alpha, source: "system" });
  expect(createRuntimeKnowledgeSkillStore(root, system).read(personal.skillId)).toEqual(personal);
});
