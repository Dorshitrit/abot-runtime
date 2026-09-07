import { describe, expect, it, vi } from "vitest";
import { LocalMemoryDispatcher } from "../local-host/app-memory-dispatch.js";
import { dispatchLocalServiceCall } from "../local-host/app-service-dispatch.js";
import type { LocalRuntimePeer } from "../local-host/contracts.js";
import type { RuntimeEnvironmentServices } from "../composition.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";

function memoryPeer(id: string) {
  const closed = new Set<() => void>();
  const callClient = vi.fn<LocalRuntimePeer["callClient"]>(
    async () => undefined,
  );
  return {
    peer: {
      id,
      callClient,
      onClose(listener: () => void) {
        closed.add(listener);
        return () => {
          closed.delete(listener);
        };
      },
    },
    callClient,
    close() {
      for (const listener of closed) listener();
    },
    listenerCount: () => closed.size,
  };
}

function abortableMemory() {
  let receivedSignal: AbortSignal | undefined;
  const search = vi.fn<LongTermMemoryService["search"]>(async ({ context }) => {
    receivedSignal = context.abortSignal;
    await new Promise<void>((resolve, reject) => {
      if (context.abortSignal.aborted) reject(new Error("memory_aborted"));
      context.abortSignal.addEventListener(
        "abort",
        () => reject(new Error("memory_aborted")),
        { once: true },
      );
    });
    return { items: [], total: 0 };
  });
  return {
    memory: { search } as unknown as LongTermMemoryService,
    search,
    signal: () => receivedSignal,
  };
}

describe("local owner memory and service dispatch", () => {
  it("never begins a queued operation cancelled while its client was connecting", async () => {
    const fixture = abortableMemory();
    const dispatcher = new LocalMemoryDispatcher(fixture.memory);
    const origin = memoryPeer("origin");
    await expect(
      dispatcher.call("memory.cancel", ["operation"], origin.peer),
    ).resolves.toBe(false);
    await expect(
      dispatcher.call(
        "memory.search",
        [
          { query: "preference", context: {} },
          { operationId: "operation", cancelled: true },
        ],
        origin.peer,
      ),
    ).rejects.toThrow("local_runtime_operation_cancelled");
    expect(fixture.search).not.toHaveBeenCalled();
    expect(origin.listenerCount()).toBe(0);
  });
  it("reconstructs a cancellable memory context and rejects cancellation from another peer", async () => {
    const fixture = abortableMemory();
    const dispatcher = new LocalMemoryDispatcher(fixture.memory);
    const first = memoryPeer("first");
    const other = memoryPeer("other");
    const pending = dispatcher.call(
      "memory.search",
      [
        { query: "preference", context: { debugRequestId: "debug" } },
        { operationId: "operation" },
      ],
      first.peer,
    );
    expect(fixture.signal()).toBeInstanceOf(AbortSignal);
    await expect(
      dispatcher.call("memory.cancel", ["operation"], other.peer),
    ).resolves.toBe(false);
    expect(fixture.signal()!.aborted).toBe(false);
    await expect(
      dispatcher.call("memory.cancel", ["operation"], first.peer),
    ).resolves.toBe(true);
    await expect(pending).rejects.toThrow("memory_aborted");
    expect(first.listenerCount()).toBe(0);
  });

  it("aborts a memory operation when its connection closes", async () => {
    const fixture = abortableMemory();
    const dispatcher = new LocalMemoryDispatcher(fixture.memory);
    const origin = memoryPeer("origin");
    const pending = dispatcher.call(
      "memory.search",
      [{ query: "preference", context: {} }, { operationId: "operation" }],
      origin.peer,
    );
    origin.close();
    await expect(pending).rejects.toThrow("memory_aborted");
    expect(origin.listenerCount()).toBe(0);
  });

  it("forwards memory events with the exact operation correlation", async () => {
    const origin = memoryPeer("origin");
    const retrieve = vi.fn<LongTermMemoryService["retrieve"]>(
      async ({ context }) => {
        context.onEvent?.("memory.retrieved", { count: 1 });
        return { available: true, records: [] };
      },
    );
    const dispatcher = new LocalMemoryDispatcher({
      retrieve,
    } as unknown as LongTermMemoryService);
    await dispatcher.call(
      "memory.retrieve",
      [
        {
          query: "preference",
          context: { requestId: "request", sessionId: "session" },
        },
        { operationId: "operation" },
      ],
      origin.peer,
    );
    expect(origin.callClient).toHaveBeenCalledWith("memory.event", [
      "operation",
      "memory.retrieved",
      { count: 1 },
    ]);
    expect(origin.listenerCount()).toBe(0);
  });

  it("does not allow prototype or unknown memory methods", async () => {
    const dispatcher = new LocalMemoryDispatcher({} as LongTermMemoryService);
    const { peer } = memoryPeer("origin");
    await expect(
      dispatcher.call("memory.constructor", [], peer),
    ).rejects.toThrow("local_runtime_method_unknown");
    await expect(dispatcher.call("memory.enabled", [], peer)).rejects.toThrow(
      "local_runtime_method_unknown",
    );
  });

  it("dispatches only explicitly allowed service methods with their receiver intact", async () => {
    const sessions = {
      marker: "same-store",
      async getSessionById() {
        return this.marker;
      },
    };
    const services = { sessions } as unknown as RuntimeEnvironmentServices;
    await expect(
      dispatchLocalServiceCall(services, "sessions.getSessionById", [
        "session",
      ]),
    ).resolves.toBe("same-store");
    await expect(
      dispatchLocalServiceCall(services, "sessions.constructor", []),
    ).rejects.toThrow("local_runtime_method_unknown");
    await expect(
      dispatchLocalServiceCall(services, "sessions.getSessionById.extra", []),
    ).rejects.toThrow("local_runtime_method_unknown");
    await expect(
      dispatchLocalServiceCall(
        services,
        "sessions.updateSessionRuntimeMode",
        [],
      ),
    ).rejects.toThrow("local_runtime_method_unavailable");
    await expect(
      dispatchLocalServiceCall(services, "scheduler.stop", []),
    ).rejects.toThrow("local_runtime_method_unknown");
  });
});
