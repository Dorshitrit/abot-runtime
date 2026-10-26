import type { BasketDiscoveryChange } from "./contracts.js";
import { basketDiscoveryChange } from "./discovery-changes.js";
import type { BasketRepository, BasketSnapshot } from "./index-records.js";

export type BasketStateOwner = ReturnType<typeof createBasketStateOwner>;

/** One cached committed snapshot; indexing promises never become request state. */
export function createBasketStateOwner(repository: BasketRepository, onChanged?: () => void) {
  let current: BasketSnapshot | undefined;
  let loading: Promise<BasketSnapshot> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(change: BasketDiscoveryChange) => void>();
  if (onChanged) listeners.add(onChanged);
  const read = (): Promise<BasketSnapshot> => {
    if (current) return Promise.resolve(current);
    loading ??= repository.read().then(snapshot => { current = snapshot; return snapshot; })
      .catch(error => { loading = undefined; throw error; });
    return loading;
  };
  return Object.freeze({
    read,
    snapshot: () => current,
    update(change: (state: BasketSnapshot) => BasketSnapshot): Promise<BasketSnapshot> {
      const operation = pending.then(async () => {
        await read();
        let committedChange: BasketDiscoveryChange | undefined;
        const snapshot = await repository.update(state => {
          const next = change(state);
          if (next !== state) committedChange = basketDiscoveryChange(state, next);
          return next;
        });
        current = snapshot;
        if (committedChange) for (const listener of listeners) {
          try { listener(committedChange); } catch { /* A consumer cannot undo committed storage. */ }
        }
        return snapshot;
      });
      pending = operation.catch(() => undefined);
      return operation;
    },
    subscribeChanges(listener: (change: BasketDiscoveryChange) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
}
