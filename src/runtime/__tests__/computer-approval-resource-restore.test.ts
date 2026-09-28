import { afterEach, describe, expect, test, vi } from "vitest";
import { prepareSystemRequestModules } from "../../../plugins/system/source/request-system-modules.js";
import type { RequestComputers } from "../../../plugins/system/source/computer/request-computers.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import {
  RequestToolResources,
  type RequestToolResourcesSnapshot,
} from "../capabilities/request-tool-resources.js";
import {
  connectedSystemHost,
  selectedSystemModules,
  systemRequestPluginFixture,
} from "./support/system-request-plugin-fixture.js";

type ComputerCapsule = ReturnType<RequestComputers["snapshot"]>;
type SystemFixture = ReturnType<typeof systemRequestPluginFixture>;
const resourcesToDispose: RequestToolResources[] = [];
const replacementConnectionId = "550e8400-e29b-41d4-a716-446655440099";

afterEach(async () => {
  await Promise.all(
    resourcesToDispose.splice(0).map((resources) => resources.dispose()),
  );
});

function computerCapsule(
  snapshot: RequestToolResourcesSnapshot,
): ComputerCapsule {
  return snapshot.capsules["system.computers.v1"] as ComputerCapsule;
}

function changeCompanionConnection(system: SystemFixture): void {
  system.readHostStatus.mockResolvedValue({
    ...connectedSystemHost,
    connected: true,
    connectionId: replacementConnectionId,
  });
}

async function prepareComputerRequest(
  system: SystemFixture,
  saved?: RequestToolResourcesSnapshot,
) {
  const resources = new RequestToolResources();
  resourcesToDispose.push(resources);
  if (saved) resources.restore(saved);
  const modules = await prepareSystemRequestModules(
    "/runtime",
    selectedSystemModules(["system_command", "computer_observe"]),
    { observeTargets: system.observeTargets, connection: system },
    {
      requestState: resources.state,
      onRequestDispose: resources.onRequestDispose,
    },
  );
  const registry = createConfiguredToolRegistry(undefined, modules);
  const execute = vi.fn(async () => {
    throw new Error("unexpected_tool_dispatch");
  });
  const nextApprovalId = vi.fn(() => "saved-computer-approval");
  const onEvent = vi.fn();
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: registry.listNormalInvocations!(),
    toolRegistry: { execute },
    requestId: "computer-approval-restore",
    abortSignal: new AbortController().signal,
    toolPermissionMode: "ask",
    nextApprovalId,
    onEvent,
  });
  return { resources, modules, executor, execute, nextApprovalId, onEvent };
}

function prepareDesktopObservation(
  request: Awaited<ReturnType<typeof prepareComputerRequest>>,
  desktopRef: string,
) {
  const operation = request.executor.operations.find(
    (entry) => entry.operation.operationId === "observe_computer_desktop",
  );
  if (!operation) throw new Error("fixture_computer_operation_missing");
  const prepared = request.executor.prepare({
    handle: operation.handle,
    controls: { desktop_ref: desktopRef },
  });
  if (prepared.status !== "prepared")
    throw new Error(`fixture_computer_prepare_failed:${prepared.code}`);
  return prepared;
}

function expectNoComputerDispatch(
  system: SystemFixture,
  ...requests: Awaited<ReturnType<typeof prepareComputerRequest>>[]
): void {
  expect(system.native).not.toHaveBeenCalled();
  expect(system.executeHostOperation).not.toHaveBeenCalled();
  for (const request of requests) {
    expect(request.execute).not.toHaveBeenCalled();
    expect(request.onEvent).not.toHaveBeenCalled();
    expect(request.resources.hasActiveWork()).toBe(false);
  }
}

describe("prepared computer approval resource restoration", () => {
  test("retains an exact native operation when an unused companion reconnects", async () => {
    const system = systemRequestPluginFixture();
    const first = await prepareComputerRequest(system);
    const saved = JSON.parse(
      JSON.stringify(first.resources.snapshot()),
    ) as RequestToolResourcesSnapshot;
    const [native, companion] = computerCapsule(saved).entries;
    expect(native!.routeIdentity).toContain('"native"');
    expect(companion!.routeIdentity).toContain('"companion"');
    const prepared = prepareDesktopObservation(first, native!.ref);
    const invocation = JSON.parse(JSON.stringify(prepared.snapshot));
    await first.resources.dispose();
    changeCompanionConnection(system);

    const second = await prepareComputerRequest(system, saved);
    expect(() => second.resources.assertRestoredStateClaimed()).not.toThrow();
    const restored = second.executor.restore(invocation);
    expect(restored).toMatchObject({
      status: "prepared",
      actionFingerprint: prepared.actionFingerprint,
      acceptedControls: { desktop_ref: native!.ref },
      approvalRequest: prepared.approvalRequest,
    });
    expect(computerCapsule(second.resources.snapshot()).entries).toEqual([
      native,
    ]);
    expect(second.nextApprovalId).not.toHaveBeenCalled();
    expectNoComputerDispatch(system, first, second);
  });

  test("never rebinds a prepared companion operation to a replacement connection", async () => {
    const system = systemRequestPluginFixture();
    const first = await prepareComputerRequest(system);
    const saved = JSON.parse(
      JSON.stringify(first.resources.snapshot()),
    ) as RequestToolResourcesSnapshot;
    const [native, companion] = computerCapsule(saved).entries;
    const prepared = prepareDesktopObservation(first, companion!.ref);
    await first.resources.dispose();
    changeCompanionConnection(system);

    const second = await prepareComputerRequest(system, saved);
    expect(() =>
      second.executor.restore(JSON.parse(JSON.stringify(prepared.snapshot))),
    ).toThrow("registered_tool_snapshot_incompatible");
    expect(computerCapsule(second.resources.snapshot()).entries).toEqual([
      native,
    ]);
    expect(JSON.stringify(second.resources.snapshot())).not.toContain(
      replacementConnectionId,
    );
    expect(second.nextApprovalId).not.toHaveBeenCalled();
    expectNoComputerDispatch(system, first, second);
  });

  test.each([
    "malformed_bindings",
    "duplicate_ref",
    "duplicate_route",
  ] as const)(
    "validates %s even when the saved companion route is unavailable",
    async (corruption) => {
      const system = systemRequestPluginFixture();
      const first = await prepareComputerRequest(system);
      const saved = JSON.parse(
        JSON.stringify(first.resources.snapshot()),
      ) as RequestToolResourcesSnapshot;
      const capsule = computerCapsule(saved);
      const companion = capsule.entries[1]!;
      if (corruption === "malformed_bindings")
        companion.bindings.kind = "invalid";
      if (corruption === "duplicate_ref")
        capsule.entries.push({
          ...companion,
          routeIdentity: "unavailable-second-route",
        });
      if (corruption === "duplicate_route")
        capsule.entries.push({ ...companion, ref: "unavailable-second-ref" });
      changeCompanionConnection(system);

      await expect(prepareComputerRequest(system, saved)).rejects.toThrow(
        corruption === "malformed_bindings"
          ? "desktop_bindings_snapshot_invalid"
          : "request_computers_snapshot_invalid",
      );
      expectNoComputerDispatch(system, first);
    },
  );

  test("claims the saved capsule without exposing modules when no routes remain", async () => {
    const system = systemRequestPluginFixture([]);
    const first = await prepareComputerRequest(system);
    const saved = JSON.parse(
      JSON.stringify(first.resources.snapshot()),
    ) as RequestToolResourcesSnapshot;
    expect(computerCapsule(saved).entries).toHaveLength(1);
    system.readHostStatus.mockResolvedValue({
      paired: false,
      connected: false,
    });

    const second = await prepareComputerRequest(system, saved);
    expect(second.modules).toEqual([]);
    expect(second.executor.operations).toEqual([]);
    expect(() => second.resources.assertRestoredStateClaimed()).not.toThrow();
    expect(computerCapsule(second.resources.snapshot()).entries).toEqual([]);
    expectNoComputerDispatch(system, first, second);
  });
});
