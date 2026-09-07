import type { RuntimeEnvironmentServices } from "./composition.js";

type SchedulerOwnership = {
  references: number;
  started: boolean;
  ready: Promise<void>;
  stopping?: Promise<void>;
};

// Event-only environment wrappers retain this canonical scheduler identity.
const owners = new WeakMap<object, SchedulerOwnership>();

export function acquireHostScheduler(
  services: RuntimeEnvironmentServices | undefined,
): { ready: Promise<void>; release(): Promise<void> } {
  if (!services) {
    return { ready: Promise.resolve(), release: async () => {} };
  }
  const key = services.scheduler ?? services.startScheduler ?? services;
  const owner = retainSchedulerOwner(key, services);

  let released: Promise<void> | undefined;
  function release(): Promise<void> {
    if (released) return released;
    owner.references -= 1;
    if (hasSchedulerHostReferences(owner)) {
      released = Promise.resolve();
      return released;
    }
    if (owner.started) {
      owner.stopping = (async () => {
        await services?.stopScheduler?.();
      })();
    }
    owner.stopping ??= Promise.resolve();
    const forgetStoppedOwner = () => {
      if (owners.get(key) === owner) owners.delete(key);
    };
    void owner.stopping.then(forgetStoppedOwner, forgetStoppedOwner);
    // An abandoned queued start owns no resources and must not wait for its
    // predecessor. Keep that predecessor's barrier for the next acquisition.
    released = owner.started ? owner.stopping : Promise.resolve();
    return released;
  }
  return { ready: owner.ready, release };
}

function hasSchedulerHostReferences(
  owner: SchedulerOwnership,
): boolean {
  return owner.references > 0;
}

function retainActiveSchedulerOwner(
  owner: SchedulerOwnership | undefined,
): SchedulerOwnership | undefined {
  if (!owner) return undefined;
  if (!hasSchedulerHostReferences(owner)) return undefined;
  owner.references += 1;
  return owner;
}

function retainSchedulerOwner(
  key: object,
  services: RuntimeEnvironmentServices,
): SchedulerOwnership {
  const previous = owners.get(key);
  const retained = retainActiveSchedulerOwner(previous);
  if (retained) return retained;
  const owner: SchedulerOwnership = {
    references: 1,
    started: false,
    ready: Promise.resolve(),
    stopping: previous?.stopping,
  };
  owners.set(key, owner);
  const start = async () => {
    if (!hasSchedulerHostReferences(owner)) return;
    owner.started = true;
    await services.startScheduler?.();
  };
  owner.ready = previous?.stopping ? previous.stopping.then(start) : start();
  return owner;
}
