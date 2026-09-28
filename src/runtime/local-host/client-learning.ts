import type {
  LearningChangedEvent,
  PassiveLearningService,
} from "../passive-learning/contracts.js";
import type { LocalRuntimeCallHandler } from "./contracts.js";
import { projectLearningChangedEvent } from "./learning-events.js";

export type PassiveLearningManagement = Pick<
  PassiveLearningService,
  | "status"
  | "configure"
  | "clearPending"
  | "restartCollection"
  | "batches"
  | "batch"
  | "candidates"
  | "dismissProposal"
>;

/** Read models and invalidations only; collection is never owned by a client. */
export function createLocalLearningClient(call: LocalRuntimeCallHandler) {
  const listeners = new Set<(event?: LearningChangedEvent) => void>();
  const service: PassiveLearningManagement = {
    status: () =>
      call("learning.status", []) as ReturnType<
        PassiveLearningManagement["status"]
      >,
    configure: (input) =>
      call("learning.configure", [input]) as ReturnType<
        PassiveLearningManagement["configure"]
      >,
    clearPending: () =>
      call("learning.clearPending", []) as ReturnType<
        PassiveLearningManagement["clearPending"]
      >,
    restartCollection: () =>
      call("learning.restartCollection", []) as ReturnType<
        NonNullable<PassiveLearningManagement["restartCollection"]>
      >,
    batches: (input) =>
      call("learning.batches", [input]) as ReturnType<
        PassiveLearningManagement["batches"]
      >,
    batch: (id) =>
      call("learning.batch", [id]) as ReturnType<
        PassiveLearningManagement["batch"]
      >,
    candidates: () =>
      call("learning.candidates", []) as ReturnType<
        NonNullable<PassiveLearningManagement["candidates"]>
      >,
    dismissProposal: (id) =>
      call("learning.dismissProposal", [id]) as Promise<void>,
  };
  return {
    service,
    subscribe(listener: (event?: LearningChangedEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    receive(event: unknown) {
      if (!event || typeof event !== "object") return;
      if (!("type" in event) || event.type !== "learning.changed") return;
      const change = projectLearningChangedEvent(
        "event" in event ? event.event : undefined,
      );
      for (const listener of listeners) {
        try {
          if (change) listener(change);
          else listener();
        } catch {
          /* Views do not own committed state. */
        }
      }
    },
    close() {
      listeners.clear();
    },
  };
}
