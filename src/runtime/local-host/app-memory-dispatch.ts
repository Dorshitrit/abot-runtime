import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LocalRuntimePeer } from "./contracts.js";

const MEMORY_METHODS = [
  "status",
  "list",
  "search",
  "create",
  "update",
  "delete",
  "clear",
  "retrieve",
  "processCandidates",
  "scheduleCandidates",
] as const satisfies readonly (keyof LongTermMemoryService)[];

const CONTEXT_METHODS: readonly string[] = [
  "search",
  "create",
  "update",
  "retrieve",
  "processCandidates",
  "scheduleCandidates",
];

type ActiveMemoryOperation = {
  peerId: string;
  controller: AbortController;
};

function readOperationId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const operationId = (value as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId
    ? operationId
    : undefined;
}

function isQueuedOperationCancelled(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (value as { cancelled?: unknown }).cancelled === true;
}

export class LocalMemoryDispatcher {
  private readonly active = new Map<string, ActiveMemoryOperation>();

  constructor(private readonly memory: LongTermMemoryService) {}

  async call(
    method: string,
    args: readonly unknown[],
    peer: LocalRuntimePeer,
  ): Promise<unknown> {
    const operation = method.slice("memory.".length);
    if (operation === "cancel") return this.cancel(args[0], peer.id);
    if (!(MEMORY_METHODS as readonly string[]).includes(operation))
      throw new Error("local_runtime_method_unknown");
    const operationId = readOperationId(args.at(-1));
    if (isQueuedOperationCancelled(args.at(-1)))
      throw new Error("local_runtime_operation_cancelled");
    const inputArgs = operationId ? args.slice(0, -1) : [...args];
    if (operationId && this.active.has(operationId))
      throw new Error("local_runtime_operation_already_active");
    const controller = new AbortController();
    const removeClose = peer.onClose(() => controller.abort());
    if (operationId)
      this.active.set(operationId, { peerId: peer.id, controller });
    const callArgs = this.bindContext(
      operation,
      inputArgs,
      peer,
      controller.signal,
      operationId,
    );
    try {
      const invoke = this.memory[operation as (typeof MEMORY_METHODS)[number]];
      return await (invoke as (...values: unknown[]) => unknown).apply(
        this.memory,
        callArgs,
      );
    } finally {
      removeClose();
      if (operationId) this.active.delete(operationId);
    }
  }

  stop(): void {
    for (const operation of this.active.values()) operation.controller.abort();
    this.active.clear();
  }

  private cancel(operationId: unknown, peerId: string): boolean {
    if (typeof operationId !== "string") return false;
    const operation = this.active.get(operationId);
    if (!operation || operation.peerId !== peerId) return false;
    operation.controller.abort();
    return true;
  }

  private bindContext(
    operation: string,
    args: readonly unknown[],
    peer: LocalRuntimePeer,
    abortSignal: AbortSignal,
    operationId?: string,
  ): unknown[] {
    if (!CONTEXT_METHODS.includes(operation)) return [...args];
    const input = args[0] as { context?: Record<string, unknown> } | undefined;
    if (!input || typeof input !== "object")
      throw new Error("local_runtime_memory_input_invalid");
    return [
      {
        ...input,
        context: {
          ...input.context,
          abortSignal,
          onEvent: (name: string, extra?: Record<string, unknown>) => {
            void peer
              .callClient("memory.event", [operationId, name, extra])
              .catch(() => undefined);
          },
        },
      },
      ...args.slice(1),
    ];
  }
}
