import { rm } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { createBasketSourceListing } from "../information-basket/source-listing.js";
import { createBasketServiceWork } from "../information-basket/service-work.js";
import { healthState } from "./support/information-basket-health-fixture.js";
import { createBasketFixture } from "./support/information-basket-fixture.js";

test.each(["indexing", "reindexing"] as const)("LIST excludes a source that finishes %s during verification", async mode => {
  const fixture = await createBasketFixture();
  const work = createBasketServiceWork();
  try {
    const f = await healthState(2);
    const latest = { ...f.sources[1]!, revision: 2 };
    if (mode === "indexing") await f.state.update(state => ({ ...state,
      sources: [state.sources[0]!, { ...latest, status: "indexing", index: null }],
    }));
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const validate = vi.fn(async () => blocked);
    const list = createBasketSourceListing({ config: fixture.config, state: f.state, work, health: { validate } });
    const pending = list({ verifySources: true });
    await setImmediate();
    await f.state.update(state => ({ ...state, sources: [state.sources[0]!, latest] }));
    release();
    const view = await pending;
    expect(view.sources.map(source => source.sourceId)).toEqual([f.sources[0]!.sourceId]);
    expect(validate).toHaveBeenCalledOnce();
    // Management sees current state, while the next explicit LIST validates the new binding.
    expect((await list()).sources).toHaveLength(2);
    expect(validate).toHaveBeenCalledOnce();
    expect((await list({ verifySources: true })).sources).toHaveLength(2);
    expect(validate).toHaveBeenCalledTimes(2);
  } finally {
    await work.stop();
    await fixture.service.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
