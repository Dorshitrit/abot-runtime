import { isNativeCredential } from "./native-state.js";
import { isObservationControl } from "./observation-protocol.js";
import {
  isHostIdentifier,
  isHostWireOperation,
  isHostRecord,
  type HostServerMessage,
} from "./protocol.js";

function hasOnlyFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

export function readNativeServerMessage(text: string): HostServerMessage {
  const value: unknown = JSON.parse(text);
  if (!isHostRecord(value)) throw new Error("Invalid host protocol message.");
  if (isObservationControl(value)) return value;
  if (value.type === "paired") {
    if (!hasOnlyFields(value, ["type", "hostId", "credential"]))
      throw new Error("Unexpected pairing fields.");
    if (!isHostIdentifier(value.hostId))
      throw new Error("Invalid paired host identity.");
    if (!isNativeCredential(value.credential))
      throw new Error("Invalid paired credential.");
    return {
      type: "paired",
      hostId: value.hostId,
      credential: value.credential,
    };
  }
  if (value.type === "ready") {
    if (!hasOnlyFields(value, ["type", "hostId"]))
      throw new Error("Unexpected readiness fields.");
    if (!isHostIdentifier(value.hostId))
      throw new Error("Invalid ready host identity.");
    return { type: "ready", hostId: value.hostId };
  }
  if (value.type === "cancel") {
    if (!hasOnlyFields(value, ["type", "id"]))
      throw new Error("Unexpected cancellation fields.");
    if (!isHostIdentifier(value.id))
      throw new Error("Invalid cancellation identity.");
    return { type: "cancel", id: value.id };
  }
  if (value.type !== "execute")
    throw new Error("Unsupported host protocol message.");
  if (!hasOnlyFields(value, ["type", "id", "hostId", "operation", "params"]))
    throw new Error("Unexpected execution fields.");
  if (!isHostIdentifier(value.id))
    throw new Error("Invalid operation identity.");
  if (!isHostIdentifier(value.hostId))
    throw new Error("Invalid operation host identity.");
  if (!isHostWireOperation(value.operation))
    throw new Error("Unsupported native operation.");
  if (!isHostRecord(value.params))
    throw new Error("Invalid native operation parameters.");
  return {
    type: "execute",
    id: value.id,
    hostId: value.hostId,
    operation: value.operation,
    params: value.params,
  };
}

const NATIVE_OPERATION_FIELDS = {
  desktop_notification: ["target", "notificationId", "title", "body", "url"],
  system_targets: [],
  system_command: ["target", "command", "cwd", "elevated", "timeout_ms"],
  system_applications: ["target", "query", "limit"],
  system_launch: ["target", "application_id", "arguments"],
  computer_execute: ["target", "sessionId", "request"],
  computer_frame: ["target", "sessionId", "frameId", "offset"],
  computer_close: ["target", "sessionId"],
} as const;

export class NativeOperationInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function assertNativeOperationTarget(
  message: Extract<HostServerMessage, { type: "execute" }>,
  os: string,
): void {
  if (
    !hasOnlyFields(message.params, NATIVE_OPERATION_FIELDS[message.operation])
  )
    throw new NativeOperationInputError(
      "system_command_invalid",
      "The native operation contains unsupported parameters.",
    );
  if (message.operation === "system_targets") return;
  if (message.params.target !== os)
    throw new NativeOperationInputError(
      "system_target_unavailable",
      "The operation must address this companion's native operating system.",
    );
}
