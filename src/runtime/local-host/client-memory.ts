import { randomUUID } from "node:crypto";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LocalRuntimeCallHandler } from "./contracts.js";

type MemoryContext = {
  abortSignal?: AbortSignal;
  onEvent?: (name: string, extra?: Record<string, unknown>) => void;
  [key: string]: unknown;
};

/** Moves cancellation and callbacks explicitly; executable values never cross IPC. */
export function createLocalMemoryClient(
  call: LocalRuntimeCallHandler,
  enabled: boolean,
) {
  const eventListeners = new Map<
    string,
    NonNullable<MemoryContext["onEvent"]>
  >();
  async function invoke(method: string, input?: unknown): Promise<unknown> {
    const operationId = randomUUID();
    const operation = { operationId, cancelled: false };
    const record = input as { context?: MemoryContext } | undefined;
    const context = record?.context;
    if (context?.abortSignal?.aborted) throw context.abortSignal.reason;
    const { abortSignal, onEvent, ...serializableContext } = context ?? {};
    const argument = context
      ? { ...record, context: serializableContext }
      : input;
    if (onEvent) eventListeners.set(operationId, onEvent);
    const abort = () => {
      operation.cancelled = true;
      void call("memory.cancel", [operationId]).catch(() => undefined);
    };
    abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      return await call(`memory.${method}`, [argument, operation]);
    } finally {
      abortSignal?.removeEventListener("abort", abort);
      eventListeners.delete(operationId);
    }
  }
  const service = {
    enabled,
    status: () => invoke("status"),
    list: (input: unknown) => invoke("list", input),
    search: (input: unknown) => invoke("search", input),
    create: (input: unknown) => invoke("create", input),
    update: (input: unknown) => invoke("update", input),
    delete: (input: unknown) => invoke("delete", input),
    clear: () => invoke("clear"),
    retrieve: (input: unknown) => invoke("retrieve", input),
    processCandidates: (input: unknown) => invoke("processCandidates", input),
    scheduleCandidates: (input: unknown) => {
      void invoke("scheduleCandidates", input).catch((error) => {
        console.error("Local runtime memory scheduling failed:", error);
      });
    },
  } as LongTermMemoryService;
  return {
    service,
    handleEvent(args: readonly unknown[]): void {
      eventListeners.get(String(args[0]))?.(
        String(args[1]),
        args[2] as Record<string, unknown>,
      );
    },
  };
}
