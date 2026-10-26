import { rm } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { BASKET_LIMITS } from "../information-basket/limits.js";
import { basketProfileSignature } from "../information-basket/profile-binding.js";
import { createBasketSearch } from "../information-basket/search.js";
import { createBasketSourceHealth } from "../information-basket/source-health.js";
import { healthState } from "./support/information-basket-health-fixture.js";
import { createBasketFixture } from "./support/information-basket-fixture.js";

test("1,000 matching indexes validate only eight file identities and never extract contents", async () => {
  const fixture = await createBasketFixture();
  try {
    const f = await healthState(1_000);
    const signature = basketProfileSignature(fixture.config, "fixture");
    await f.state.update(state => ({ ...state, sources: state.sources.map(source => ({ ...source,
      index: { ...source.index!, profileSignature: signature },
    })) }));
    const readIdentity = vi.fn(async () => f.sources[0]!.index!.fileIdentity);
    const health = createBasketSourceHealth({ state: f.state, readIdentity });
    const readSource = vi.fn();
    const search = createBasketSearch({ config: fixture.config, models: { embed: fixture.embed },
      state: f.state, readSource, validateSources: health.validate });
    let settled = false;
    const pending = search({ query: "apple", abortSignal: new AbortController().signal })
      .then(value => { settled = true; return value; });
    await setImmediate();
    expect(settled).toBe(false);
    const result = await pending;
    expect(result.sources).toHaveLength(5);
    expect(result.omittedCount).toBe(3);
    expect(readIdentity).toHaveBeenCalledTimes(BASKET_LIMITS.maxSearchSources);
    expect(readSource).not.toHaveBeenCalled();
    expect(fixture.embed).toHaveBeenCalledOnce();
  } finally {
    await fixture.service.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
