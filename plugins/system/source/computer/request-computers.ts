import { randomUUID } from "node:crypto";
import type {
  SystemRequestRoute,
  SystemTargetSnapshot,
} from "../request-target-snapshot.js";
import {
  routeTargetId,
  systemRouteMetadata,
  systemRouteBindingIdentity,
} from "../request-target-snapshot.js";
import type { SystemHostConnection } from "../host-dispatch.js";
import { SystemOperationError } from "../../../../src/plugin-sdk/computer-access.js";
import type { NativeComputerBackend } from "../../../../src/plugin-sdk/computer-access.js";
import { createNativeComputerBackend } from "../../../../src/plugin-sdk/computer-access.js";
import { createCompanionComputerBackend } from "../../../../src/plugin-sdk/computer-access.js";
import { COMPUTER_CAPABILITY } from "../../../../src/plugin-sdk/computer-access.js";
import { DesktopBindings } from "./desktop-bindings.js";

export type RequestComputer = {
  ref: string;
  route: SystemRequestRoute;
  bindings: DesktopBindings;
  backend?: NativeComputerBackend;
};
export class RequestComputers {
  readonly entries: readonly RequestComputer[];
  private closed = false;
  constructor(
    private readonly rootDir: string,
    routes: SystemTargetSnapshot,
    private readonly connection: SystemHostConnection,
    private readonly nativeFactory = createNativeComputerBackend,
    snapshot?: unknown,
  ) {
    this.entries =
      snapshot === undefined
        ? routes.map((route) => ({
            ref: randomUUID(),
            route,
            bindings: new DesktopBindings(),
          }))
        : restoreComputers(routes, snapshot);
  }
  snapshot() {
    if (this.closed) throw new Error("computer_request_closed");
    return {
      kind: "request_computers_v1",
      entries: this.entries.map((entry) => ({
        ref: entry.ref,
        routeIdentity: systemRouteBindingIdentity(entry.route),
        bindings: entry.bindings.snapshot(),
      })),
    };
  }
  require(ref: unknown): RequestComputer {
    if (this.closed)
      throw new SystemOperationError(
        "computer_request_closed",
        "This request's desktop bindings have expired.",
      );
    const entry = this.entries.find((candidate) => candidate.ref === ref);
    if (!entry)
      throw new SystemOperationError(
        "computer_desktop_unavailable",
        "Select a desktop reference offered in this request.",
      );
    return entry;
  }
  backend(entry: RequestComputer): NativeComputerBackend {
    if (this.closed)
      throw new SystemOperationError(
        "computer_request_closed",
        "The computer request has closed.",
      );
    if (!supportsComputerRoute(entry.route))
      throw new SystemOperationError(
        "computer_companion_upgrade_required",
        "Install the companion from this Runtime build to enable desktop observation and input.",
      );
    if (entry.backend) return entry.backend;
    entry.backend =
      entry.route.kind === "native"
        ? this.nativeFactory(entry.route.target)
        : createCompanionComputerBackend(
            this.rootDir,
            entry.route,
            this.connection,
          );
    return entry.backend;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries) entry.bindings.clear();
    await Promise.allSettled(
      this.entries.map((entry) => entry.backend?.close()),
    );
  }
}
export function computerRouteLabel(entry: RequestComputer) {
  return {
    desktop_ref: entry.ref,
    platform: routeTargetId(entry.route),
    ...systemRouteMetadata(entry.route),
  };
}
export function computerQueueIdentity(entry: RequestComputer): string {
  // Local transports can alias one physical desktop (for example WSL and companion).
  // Keep their identities distinct while conservatively serializing the same OS.
  return `computer-local-platform:${routeTargetId(entry.route)}`;
}
function supportsComputerRoute(route: SystemRequestRoute): boolean {
  if (route.kind === "native") return true;
  return route.capabilities?.includes(COMPUTER_CAPABILITY) === true;
}

function restoreComputers(
  routes: SystemTargetSnapshot,
  value: unknown,
): RequestComputer[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "request_computers_v1" ||
    !("entries" in value) ||
    !Array.isArray(value.entries)
  )
    throw new Error("request_computers_snapshot_invalid");
  const refs = new Set<string>(),
    identities = new Set<string>();
  return value.entries.flatMap((entry) => {
    if (
      !entry ||
      typeof entry.ref !== "string" ||
      !entry.ref ||
      typeof entry.routeIdentity !== "string" ||
      refs.has(entry.ref) ||
      identities.has(entry.routeIdentity)
    )
      throw new Error("request_computers_snapshot_invalid");
    refs.add(entry.ref);
    identities.add(entry.routeIdentity);
    const bindings = new DesktopBindings();
    bindings.restore(entry.bindings);
    const route = routes.find(
      (route) => systemRouteBindingIdentity(route) === entry.routeIdentity,
    );
    // Discovery captured unused routes too. Exact prepared actions still require
    // their original ref; an unavailable route is never rebound to a new target.
    const hasSavedRoute = route !== undefined;
    if (!hasSavedRoute) return [];
    return [{ ref: entry.ref, route, bindings }];
  });
}
