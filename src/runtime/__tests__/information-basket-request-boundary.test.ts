import { expect, test, vi } from "vitest";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createInformationBasketToolModule } from "../capabilities/information-basket/tool-module.js";
import { createKnowledgeSkillsToolModule } from "../capabilities/knowledge-skills/tool-module.js";
import { builtinKnowledgeSkillStore } from "../knowledge-skills/catalog.js";
import { bindKnowledgeSkillsToRequest } from "../knowledge-skills/request-store.js";
import { createKnowledgeSkillStore } from "../knowledge-skills/store.js";
import type { InformationBasketService } from "../information-basket/contracts.js";

function registryFixture() {
  const search = vi.fn(async () => ({ status: "empty", sources: [], omittedCount: 0 }));
  const service = { isReady: () => true, search } as unknown as InformationBasketService;
  const registry = createConfiguredToolRegistry(undefined, [
    createInformationBasketToolModule(service), createKnowledgeSkillsToolModule(builtinKnowledgeSkillStore),
  ]);
  return { registry, search };
}

test("SUPER excludes basket across registry surfaces and direct tool/Skill access", async () => {
  const f = registryFixture();
  const registry = await f.registry.prepareRequest!({ rootContractId: "supervisor" });
  expect(registry.listDefinitions().map(tool => tool.name)).not.toContain("information_basket");
  expect(registry.listNormalInvocations!().map(tool => tool.toolName)).not.toContain("information_basket");
  expect(registry.getDefinition("information_basket")).toBeUndefined();
  expect(registry.getAdapter!("information_basket")).toBeUndefined();
  expect(registry.getImplementations()).not.toHaveProperty("information_basket");
  expect((await registry.execute({ tool: "information_basket", params: { action: "search_information_sources", query: "anything" } })).ok).toBe(false);
  const skill = registry.getImplementations().abot_skills!;
  const list = await skill({ action: "list_skills" });
  expect(JSON.parse(list.output).skills.some((entry: { skillId: string }) => entry.skillId === "information-basket")).toBe(false);
  for (const ref of ["information-basket", "Information Basket"]) {
    expect((await skill({ action: "read_skill", skillId: ref })).ok).toBe(false);
    expect((await skill({ action: "read_skills", skillIds: ["computer-use", ref] })).ok).toBe(false);
  }
  expect((await skill({ action: "read_skill", skillId: "computer-use" })).ok).toBe(true);
  expect(f.search).not.toHaveBeenCalled();
});

test("EA retains tools and Skill after an independent SUPER request is prepared", async () => {
  const f = registryFixture();
  const superRegistry = await f.registry.prepareRequest!({ rootContractId: "supervisor" });
  const ea = await f.registry.prepareRequest!({ rootContractId: "execution_agent" });
  expect(ea.listNormalInvocations!().find(tool => tool.toolName === "information_basket")!.contract.operations.map(operation => operation.operationId))
    .toEqual(["list_information_sources", "search_information_sources", "read_information_source"]);
  expect((await ea.getImplementations().abot_skills!({ action: "read_skill", skillId: "information-basket" })).ok).toBe(true);
  expect((await ea.getImplementations().information_basket!({ action: "search_information_sources", query: "example" })).ok).toBe(true);
  expect(f.search).toHaveBeenCalledOnce();
  expect(superRegistry.getDefinition("information_basket")).toBeUndefined();
});

test("request Skill visibility uses definition metadata without affecting unrelated guidance or the shared store", () => {
  const custom = { skillId: "custom", name: "Custom", description: "Reference", content: "Custom content" };
  const store = createKnowledgeSkillStore([
    custom, { ...custom, skillId: "ea-only", requestRootContracts: ["execution_agent"] },
  ]);
  const view = bindKnowledgeSkillsToRequest(store, "supervisor");
  expect(view.list().map(skill => skill.skillId)).toEqual(["custom"]);
  expect(view.read("ea-only")).toBeUndefined();
  expect(view.read("custom")).toEqual(store.read("custom"));
  expect(store.read("ea-only")).toBeDefined();
  expect(bindKnowledgeSkillsToRequest(store, "execution_agent")).toBe(store);
});
