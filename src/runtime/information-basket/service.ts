import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { InformationBasketOptions, InformationBasketService } from "./contracts.js";
import { browseBasketFiles } from "./file-browser.js";
import { createBasketIndexQueue } from "./index-queue.js";
import { createBasketManagement } from "./management.js";
import { createBasketRepository } from "./repository.js";
import { createBasketSearch } from "./search.js";
import { readBasketSourceDocument } from "./source-reader.js";
import { createBasketSourceReading } from "./source-reading.js";
import { createBasketStateOwner } from "./state-owner.js";
import { createBasketServiceWork } from "./service-work.js";
import { isBasketRetrievalReady } from "./readiness.js";
import { createBasketSourceHealth } from "./source-health.js";
import { createBasketSourceHealthMonitor } from "./source-health-monitor.js";
import { createBasketSourceListing } from "./source-listing.js";

/** Personal source registry shared by chats in this Runtime environment. */
export function createInformationBasketService(options: InformationBasketOptions): InformationBasketService {
  const namespace = createHash("sha256").update(JSON.stringify({
    schema: 1, runtimeId: options.config.runtimeId, host: hostname(), platform: process.platform,
  })).digest("hex");
  const state = createBasketStateOwner(
    createBasketRepository(join(options.config.paths.runtimeDir, "information-basket"), namespace), options.onChanged,
  );
  const work = createBasketServiceWork();
  const queue = createBasketIndexQueue({ ...options, state, reader: readBasketSourceDocument });
  const readSource = createBasketSourceReading(state, readBasketSourceDocument);
  const health = createBasketSourceHealth({ state });
  const healthMonitor = createBasketSourceHealthMonitor(state, health);
  const search = createBasketSearch({ ...options, state, readSource, validateSources: health.validate });
  const management = createBasketManagement({ ...options, state, queue });
  let started = false;
  let lifecycleVersion = 0;
  let starting: Promise<void> | undefined;
  const start = (): Promise<void> => {
    if (started) return Promise.resolve();
    if (starting) return starting;
    const version = lifecycleVersion;
    const pending = queue.start().then(() => {
      if (version !== lifecycleVersion) return;
      work.start();
      started = true;
      healthMonitor.start();
    });
    starting = pending;
    void pending.finally(() => { if (starting === pending) starting = undefined; }).catch(() => undefined);
    return pending;
  };
  const list = createBasketSourceListing({ config: options.config, state, health, work });
  return Object.freeze({
    isReady: () => isBasketRetrievalReady({ ...options, snapshot: state.snapshot(), started }),
    list,
    async updateSettings(input) { await management.updateSettings(input); return list(); },
    async addSources(input) { await management.addSources(input); return list(); },
    async removeSource(input) { await management.removeSource(input); return list(); },
    async refreshSource(input) { await management.refreshSource(input); return list(); },
    async relinkSource(input) { await management.relinkSource(input); return list(); },
    browseFiles: input => browseBasketFiles(options.config.paths.agentWorkDir, input),
    search: input => work.run(input.abortSignal, abortSignal => search({ ...input, abortSignal })),
    readSource: input => work.run(input.abortSignal, abortSignal => readSource({ ...input, abortSignal })),
    subscribeChanges: state.subscribeChanges,
    start,
    async stop() {
      started = false;
      lifecycleVersion += 1;
      await Promise.all([healthMonitor.stop(), queue.stop(), work.stop(), starting?.catch(() => undefined)]);
    },
  });
}
