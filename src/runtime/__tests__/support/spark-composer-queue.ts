import { emptyClientState } from "../../../web-ui/client-state/contracts.js";
import { changeClientQueue } from "../../../web-ui/client-state/queue.js";
// @ts-expect-error Browser queue adapter.
import { createServerComposerQueue } from "../../../web-ui/app/services/server-composer-queue.js";

/** Uses the production browser adapter and server queue transaction contract. */
export function createSparkQueueFixture() {
  const state = emptyClientState();
  let failure = false;
  const queue = createServerComposerQueue({
    snapshot: () => state,
    refresh: async () => state,
    execute: async (input: Record<string, unknown>) => {
      if (failure) throw new Error("storage unavailable");
      const result = changeClientQueue(state, input);
      state.revision += 1;
      return result;
    },
  });
  return { queue, failStorage: () => { failure = true; } };
}
