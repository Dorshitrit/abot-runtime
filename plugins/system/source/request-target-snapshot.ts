import {
  SystemOperationError,
  type SystemTarget,
  type SystemTargetId,
} from "../../../src/plugin-sdk/computer-access.js";
import {
  isHostIdentifier,
  isHostIdentity,
  type HostIdentity,
  type HostStatus,
} from "../../../src/plugin-sdk/computer-access.js";
import type { SystemTargetObservation } from "../../../src/plugin-sdk/computer-access.js";

export type SystemRequestRoute = Readonly<
  | { kind: "native"; target: SystemTarget }
  | {
      kind: "companion";
      target: SystemTargetId;
      hostId: string;
      connectionId: string;
      identity: HostIdentity;
      capabilities?: readonly string[];
    }
>;
export type SystemTargetSnapshot = readonly SystemRequestRoute[];

/** Capture routes once; command callers keep native OS precedence, desktop callers retain distinct routes. */
export async function captureSystemTargetSnapshot(
  input: Readonly<{
    observeTargets(): Promise<SystemTargetObservation>;
    readHostStatus(): Promise<HostStatus>;
    includeSameOsCompanion?: boolean;
  }>,
): Promise<SystemTargetSnapshot> {
  const [native, companion] = await Promise.allSettled([
    input.observeTargets(),
    input.readHostStatus(),
  ]);
  const routes = capturedNativeRoutes(native);
  if (companion.status !== "fulfilled") return Object.freeze(routes);
  const remote = connectedCompanionRoute(companion.value);
  if (!remote) return Object.freeze(routes);
  if (
    !input.includeSameOsCompanion &&
    routes.some((route) => routeTargetId(route) === remote.target)
  )
    return Object.freeze(routes);
  return Object.freeze([...routes, remote]);
}

function capturedNativeRoutes(
  observation: PromiseSettledResult<SystemTargetObservation>,
): SystemRequestRoute[] {
  if (observation.status !== "fulfilled") return [];
  return observation.value.targets.flatMap((target) => {
    if (!target.available) return [];
    return [
      Object.freeze({
        kind: "native" as const,
        target: Object.freeze({
          id: target.id,
          shell: target.shell,
          transport: target.transport,
        }),
      }),
    ];
  });
}

function connectedCompanionRoute(
  status: HostStatus,
): SystemRequestRoute | undefined {
  if (!status.paired) return undefined;
  if (!status.connected) return undefined;
  if (!isHostIdentifier(status.hostId)) return undefined;
  if (!isHostIdentifier(status.connectionId)) return undefined;
  if (!isHostIdentity(status.identity)) return undefined;
  return Object.freeze({
    kind: "companion",
    target: status.identity.os,
    hostId: status.hostId,
    connectionId: status.connectionId,
    identity: Object.freeze({ ...status.identity }),
    ...(status.capabilities
      ? { capabilities: Object.freeze([...status.capabilities]) }
      : {}),
  });
}

export function routeTargetId(route: SystemRequestRoute): SystemTargetId {
  if (route.kind === "native") return route.target.id;
  return route.target;
}

export function requireSystemRequestRoute(
  snapshot: SystemTargetSnapshot,
  target: unknown,
): SystemRequestRoute {
  const route = snapshot.find(
    (candidate) => routeTargetId(candidate) === target,
  );
  if (route) return route;
  throw new SystemOperationError(
    "system_target_unavailable",
    "The requested OS target is unavailable in this request.",
  );
}

export function resolveCapturedNativeTarget(
  snapshot: SystemTargetSnapshot,
  target: SystemTargetId,
): SystemTarget {
  const route = requireSystemRequestRoute(snapshot, target);
  if (route.kind === "native") return route.target;
  throw new SystemOperationError(
    "system_target_unavailable",
    "The request did not bind this target to native execution.",
  );
}

export function systemRouteBindingIdentity(route: SystemRequestRoute): string {
  if (route.kind === "native")
    return JSON.stringify([route.kind, route.target]);
  return JSON.stringify([
    route.kind,
    route.target,
    route.hostId,
    route.connectionId,
  ]);
}

export function systemRouteMetadata(
  route: SystemRequestRoute,
): Readonly<Record<string, unknown>> {
  if (route.kind === "native")
    return {
      displayTarget: route.target.id,
      transport: route.target.transport,
    };
  return {
    displayTarget: route.target,
    transport: "host_companion",
    computerName: route.identity.name,
  };
}

export function observeCapturedSystemTargets(snapshot: SystemTargetSnapshot) {
  return {
    targets: snapshot.map((route) => ({
      id: routeTargetId(route),
      available: true,
      ...modelSafeRouteObservation(route),
      guiSessionStatus: "not_checked" as const,
    })),
    availabilityScope: "request_execution_routes",
  } as const;
}

function modelSafeRouteObservation(route: SystemRequestRoute) {
  if (route.kind === "native")
    return {
      transport: route.target.transport,
      commandExecutionStatus: "probed",
      availabilityScope: "command_execution_only",
    } as const;
  return {
    transport: "host_companion",
    commandExecutionStatus: "not_probed",
    availabilityScope: "transport_connection_only",
  } as const;
}
