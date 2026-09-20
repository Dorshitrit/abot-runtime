import { expect, test, vi } from "vitest";
import { closeRuntimeSetupServices } from "../../web-ui/runtime-setup-shutdown.js";

test("fences runtime and host intake immediately while waiting for both before gateway release", async () => {
  let finishRuntime!: () => void;
  let finishHost!: () => void;
  const runtime = new Promise<void>((resolve) => {
    finishRuntime = resolve;
  });
  const host = new Promise<void>((resolve) => {
    finishHost = resolve;
  });
  const closeRuntime = vi.fn(() => runtime);
  const closeHost = vi.fn(() => host);
  const closeGateway = vi.fn(async () => {});
  const closing = closeRuntimeSetupServices(
    closeRuntime,
    closeGateway,
    closeHost,
  );
  expect(closeRuntime).toHaveBeenCalledOnce();
  expect(closeHost).toHaveBeenCalledOnce();
  expect(closeGateway).not.toHaveBeenCalled();
  finishRuntime();
  await runtime;
  expect(closeGateway).not.toHaveBeenCalled();
  finishHost();
  await closing;
  expect(closeGateway).toHaveBeenCalledOnce();
});

test("a synchronous runtime failure does not skip host cleanup or hide its failure", async () => {
  const runtimeFailure = new Error("runtime_close_failed");
  const hostFailure = new Error("host_close_failed");
  const closeGateway = vi.fn(async () => {});
  const outcome = await closeRuntimeSetupServices(
    () => {
      throw runtimeFailure;
    },
    closeGateway,
    () => {
      throw hostFailure;
    },
  ).catch((error) => error);
  expect(outcome).toBeInstanceOf(AggregateError);
  expect(outcome.errors).toEqual([runtimeFailure, hostFailure]);
  expect(closeGateway).toHaveBeenCalledOnce();
});

test("releases the gateway after runtime closure, including synchronous failures", async () => {
  const failure = new Error("runtime_close_failed");
  const calls: string[] = [];
  const closeRuntime = () => {
    calls.push("runtime");
    throw failure;
  };
  const closeGateway = vi.fn(async () => {
    calls.push("gateway");
  });
  await expect(
    closeRuntimeSetupServices(closeRuntime, closeGateway),
  ).rejects.toBe(failure);
  expect(calls).toEqual(["runtime", "gateway"]);
});

test("preserves both failures while attempting every owner", async () => {
  const runtimeFailure = new Error("runtime_close_failed");
  const gatewayFailure = new Error("gateway_close_failed");
  const closeRuntime = vi.fn(async () => {
    throw runtimeFailure;
  });
  const closeGateway = vi.fn(async () => {
    throw gatewayFailure;
  });
  const outcome = await closeRuntimeSetupServices(
    closeRuntime,
    closeGateway,
  ).catch((error) => error);
  expect(outcome).toBeInstanceOf(AggregateError);
  expect(outcome.errors).toEqual([runtimeFailure, gatewayFailure]);
  expect(closeGateway).toHaveBeenCalledOnce();
});

test("reports gateway failure after successful runtime closure", async () => {
  const failure = new Error("gateway_close_failed");
  await expect(
    closeRuntimeSetupServices(
      async () => {},
      async () => {
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
});
