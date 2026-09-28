import type { ToolRequestDisposer } from "../../capabilities/tool-media.js";
import type { ToolRequestWork } from "../../capabilities/tool-request-resources.js";
import { RequestToolMediaStore } from "../attachments/request-tool-media.js";
import type { RequestToolMediaSnapshot } from "../attachments/request-tool-media-snapshot.js";
import { RequestToolState } from "./request-tool-state.js";

export type RequestToolResourcesSnapshot = Readonly<{
  kind: "request_tool_resources_v1";
  media: RequestToolMediaSnapshot;
  capsules: Readonly<Record<string, unknown>>;
}>;

/** Owns temporary tool resources and tracks effects beyond a tool's return. */
export class RequestToolResources {
  readonly media = new RequestToolMediaStore();
  private readonly stateOwner = new RequestToolState();
  readonly state = this.stateOwner.port;
  private readonly activeWork = new Set<Promise<void>>();
  private readonly workListeners = new Set<() => void>();
  private readonly callbacks = new Set<() => void | Promise<void>>();
  private disposal?: Promise<void>;

  readonly work: ToolRequestWork = Object.freeze({
    trackUntil: (settled) => {
      if (this.disposal) throw new Error("tool_request_resources_closed");
      const observed = settled.then(
        () => undefined,
        () => undefined,
      );
      this.activeWork.add(observed);
      void observed.then(() => {
        this.activeWork.delete(observed);
        if (!this.activeWork.size)
          for (const notify of this.workListeners) notify();
      });
    },
  });
  hasActiveWork(): boolean {
    return this.activeWork.size > 0;
  }
  waitForQuiescence(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.hasActiveWork()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const clear = () => {
        this.workListeners.delete(ready);
        signal?.removeEventListener("abort", aborted);
      };
      const ready = () => {
        if (!this.hasActiveWork()) {
          clear();
          resolve();
        }
      };
      const aborted = () => {
        clear();
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      this.workListeners.add(ready);
      signal?.addEventListener("abort", aborted, { once: true });
      ready();
    });
  }
  assertRestoredStateClaimed(): void {
    this.stateOwner.assertRestoredStateClaimed();
  }
  snapshot(): RequestToolResourcesSnapshot {
    if (this.disposal || this.hasActiveWork())
      throw new Error("tool_request_resources_not_quiescent");
    return Object.freeze({
      kind: "request_tool_resources_v1",
      media: this.media.snapshot(),
      capsules: this.stateOwner.snapshot(),
    });
  }
  restore(snapshot: RequestToolResourcesSnapshot): void {
    if (this.disposal || snapshot?.kind !== "request_tool_resources_v1")
      throw new Error("tool_request_resources_invalid");
    this.media.restore(snapshot.media);
    this.stateOwner.restore(snapshot.capsules);
  }
  readonly onRequestDispose: ToolRequestDisposer = (callback) => {
    if (this.disposal) {
      void Promise.resolve()
        .then(callback)
        .catch(() => {});
      return;
    }
    this.callbacks.add(callback);
  };
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.media.dispose();
    const callbacks = [...this.callbacks];
    this.callbacks.clear();
    this.disposal = Promise.allSettled([
      this.stateOwner.dispose(),
      ...callbacks.map((callback) => Promise.resolve().then(callback)),
    ]).then(() => undefined);
    return this.disposal;
  }
}
