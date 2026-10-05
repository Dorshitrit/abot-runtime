import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import type {
  ModelGatewayInvokeParams, ModelGatewayRawInvokeParams,
} from "../ports.js";

type Invocation = ModelGatewayInvokeParams | ModelGatewayRawInvokeParams;
type Waiter = {
  signal: AbortSignal;
  grant: (release: () => void) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
};
type Slot = { active: boolean; waiting: Waiter[] };

export type AutomationModelCapacity = Readonly<{
  withInvocation: <T>(
    params: Invocation,
    fallbackPolicy: ModelGatewayPolicyConfig | undefined,
    invoke: () => Promise<T>,
  ) => Promise<T>;
}>;

/** Capacity is scoped to one Runtime environment, never to a single Agent node. */
export function createAutomationModelCapacity(): AutomationModelCapacity {
  const slots = new Map<string, Slot>();

  function lease(key: string, slot: Slot): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = slot.waiting.shift();
      if (next) {
        next.signal.removeEventListener("abort", next.onAbort);
        next.grant(lease(key, slot));
      } else {
        slot.active = false;
        slots.delete(key);
      }
    };
  }

  function acquire(key: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const slot = slots.get(key) ?? { active: false, waiting: [] };
    slots.set(key, slot);
    if (!slot.active) {
      slot.active = true;
      return Promise.resolve(lease(key, slot));
    }
    return new Promise<() => void>((grant, reject) => {
      const waiter: Waiter = {
        signal, grant, reject,
        onAbort: () => {
          const index = slot.waiting.indexOf(waiter);
          if (index < 0) return;
          slot.waiting.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort);
          reject(signal.reason);
        },
      };
      slot.waiting.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
    });
  }

  return {
    async withInvocation<T>(
      params: Invocation,
      fallbackPolicy: ModelGatewayPolicyConfig | undefined,
      invoke: () => Promise<T>,
    ): Promise<T> {
      params.abortSignal.throwIfAborted();
      const profile = resolveModelInvocation({
        ...params,
        modelPolicy: params.modelPolicy ?? fallbackPolicy,
      }).profile;
      if (profile.provider !== "ollama") return invoke();
      const release = await acquire(profile.providerId, params.abortSignal);
      try {
        params.abortSignal.throwIfAborted();
        return await invoke();
      } finally {
        release();
      }
    },
  };
}
