import { connect } from "node:net";
import {
  failureResult,
  type ToolImplementationOutput,
} from "../../plugin-sdk/index.js";
import { readBrokerLocation } from "./broker-location.js";
import { HostPairingStore } from "./pairing-store.js";
import {
  HOST_WIRE_MAX_BYTES,
  isHostIdentity,
  isHostIdentifier,
  isHostRecord,
  isHostToolResult,
  type HostOperation,
  type HostStatus,
} from "./protocol.js";

async function callBroker(
  rootDir: string,
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const location = readBrokerLocation(rootDir);
  if (!location) throw new Error("host_broker_unavailable");
  if (signal?.aborted) throw new Error("host_request_cancelled");
  return new Promise((resolve, reject) => {
    const socket = connect(location.socketPath);
    let received = Buffer.alloc(0);
    let settled = false;
    let sent = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) {
        reject(
          sent && request.kind === "execute"
            ? new Error("host_outcome_unknown")
            : error,
        );
        return;
      }
      resolve(result);
    };
    const abort = () =>
      finish(
        new Error(sent ? "host_outcome_unknown" : "host_request_cancelled"),
      );
    const deadline = setTimeout(
      abort,
      request.kind === "status" ? 3_000 : 615_000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      const bytes =
        JSON.stringify({ ...request, version: 1, token: location.token }) +
        "\n";
      if (Buffer.byteLength(bytes) > HOST_WIRE_MAX_BYTES) {
        finish(new Error("host_request_too_large"));
        return;
      }
      sent = true;
      socket.write(bytes);
    });
    socket.on("error", () =>
      finish(
        new Error(sent ? "host_outcome_unknown" : "host_broker_unavailable"),
      ),
    );
    socket.on("close", () =>
      finish(
        new Error(sent ? "host_outcome_unknown" : "host_broker_unavailable"),
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > HOST_WIRE_MAX_BYTES) {
        finish(new Error("host_response_too_large"));
        return;
      }
      const boundary = received.indexOf(10);
      if (boundary < 0) return;
      if (boundary !== received.length - 1) {
        finish(new Error("host_response_invalid"));
        return;
      }
      try {
        finish(
          undefined,
          JSON.parse(received.subarray(0, boundary).toString()),
        );
      } catch {
        finish(new Error("host_response_invalid"));
      }
    });
  });
}
function isHostStatus(value: unknown): value is HostStatus {
  if (!isHostRecord(value)) return false;
  if (typeof value.paired !== "boolean") return false;
  if (typeof value.connected !== "boolean") return false;
  if (!hasValidHostConnectionBinding(value)) return false;
  if (!value.paired) return value.connected === false;
  if (!isHostIdentifier(value.hostId)) return false;
  return isHostIdentity(value.identity);
}
function hasValidHostConnectionBinding(
  value: Record<string, unknown>,
): boolean {
  if (value.connected === true) return isHostIdentifier(value.connectionId);
  return !Object.hasOwn(value, "connectionId");
}
export async function readHostStatus(rootDir: string): Promise<HostStatus> {
  try {
    const response = await callBroker(rootDir, { kind: "status" });
    if (!isHostRecord(response)) throw new Error("host_response_invalid");
    if (!isHostStatus(response.status)) throw new Error("host_status_invalid");
    return response.status;
  } catch {
    const host = new HostPairingStore(rootDir).host();
    if (!host) return { paired: false, connected: false };
    return {
      paired: true,
      connected: false,
      hostId: host.hostId,
      identity: host.identity,
    };
  }
}
export async function executeHostOperation(
  rootDir: string,
  input: {
    hostId: string;
    connectionId: string;
    operation: HostOperation;
    params: Record<string, unknown>;
    abortSignal?: AbortSignal;
  },
): Promise<ToolImplementationOutput> {
  if (!isHostIdentifier(input.connectionId))
    return failureResult({
      errorCode: "system_host_binding_invalid",
      message:
        "An observed host connection identity is required before dispatch.",
      data: { outcome: "not_dispatched", retrySafe: true },
    });
  try {
    const response = await callBroker(
      rootDir,
      {
        kind: "execute",
        hostId: input.hostId,
        connectionId: input.connectionId,
        operation: input.operation,
        params: input.params,
      },
      input.abortSignal,
    );
    if (!isHostRecord(response)) throw new Error("host_outcome_unknown");
    if (response.ok !== true) throw new Error("host_outcome_unknown");
    if (!isHostToolResult(response.result))
      throw new Error("host_outcome_unknown");
    return response.result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "host_request_failed";
    const uncertain = message === "host_outcome_unknown";
    return failureResult({
      errorCode: uncertain
        ? "system_host_outcome_unknown"
        : "system_host_unavailable",
      message: uncertain
        ? "Host communication ended after dispatch. Effects may remain; inspect before retrying. The action was not replayed."
        : "The selected host connection is unavailable. No fallback target was used.",
      data: {
        outcome: uncertain ? "unknown" : "not_dispatched",
        retrySafe: !uncertain,
      },
    });
  }
}
