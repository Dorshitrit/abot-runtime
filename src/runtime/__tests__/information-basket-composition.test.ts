import { expect, test, vi } from "vitest";
import { startRuntimeInformationBasket } from "../adapters/information-basket-runtime.js";
import type { InformationBasketService } from "../information-basket/contracts.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { recomposeRuntimeEnvironment } from "../runtime-environment.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

test("the default environment shares its basket between the core capability and management", async () => {
  const fixture = await createSchedulerRuntimeFixture();
  try {
    const { informationBasket, tools } = fixture.application.services;
    expect(informationBasket).toBeDefined();
    expect(tools.getDefinition("information_basket")).toBeDefined();
    const view = await informationBasket!.list();
    expect(view.sources).toEqual([]);
    expect(view.settings.embeddingProfileId).toBeNull();
    await fixture.runOrdinaryRequest("Hello.");
    expect(fixture.invoke).toHaveBeenCalled();
  } finally { await fixture.dispose(); }
});

test("recomposition does not carry basket configuration across Runtime or model bindings", async () => {
  const fixture = await createSchedulerRuntimeFixture();
  const created = [];
  try {
    const bound = fixture.application.services;
    const same = recomposeRuntimeEnvironment(fixture.config, bound, { tools: bound.tools, models: bound.models });
    created.push(same);
    expect(same.informationBasket).toBe(bound.informationBasket);
    const replacedModels = recomposeRuntimeEnvironment(fixture.config, bound, {
      tools: bound.tools,
      models: { ...bound.models },
    });
    created.push(replacedModels);
    expect(replacedModels.informationBasket).toBeDefined();
    expect(replacedModels.informationBasket).not.toBe(bound.informationBasket);
    const replacedAttachments = recomposeRuntimeEnvironment(fixture.config, bound, {
      tools: bound.tools, attachments: { ...bound.attachments },
    });
    created.push(replacedAttachments);
    expect(replacedAttachments.informationBasket).toBeDefined();
    expect(replacedAttachments.informationBasket).not.toBe(bound.informationBasket);
    const replacedConfig = recomposeRuntimeEnvironment({ ...fixture.config, runtimeId: "different-host-binding" }, bound, {});
    created.push(replacedConfig);
    expect(replacedConfig.informationBasket).not.toBe(bound.informationBasket);
    const custom = recomposeRuntimeEnvironment(fixture.config, bound, {
      tools: createConfiguredToolRegistry(undefined, []),
    });
    created.push(custom);
    expect(custom.informationBasket).toBeUndefined();
  } finally {
    for (const service of created) {
      await service.stopScheduler?.();
      if (service.informationBasket !== fixture.application.services.informationBasket)
        await service.informationBasket?.stop();
    }
    await fixture.dispose();
  }
});

test("unavailable optional basket startup does not fail Runtime startup", async () => {
  const failure = Object.assign(new Error("basket unavailable"), { code: "basket_storage_invalid" });
  const service = { start: vi.fn(async () => { throw failure; }) } as unknown as InformationBasketService;
  await expect(startRuntimeInformationBasket(service)).resolves.toBeUndefined();
  expect(service.start).toHaveBeenCalledOnce();
});
