/** Shared computer access. Import this subpath only when your plugin uses the host. */
export {
  executeHostOperation,
  readHostStatus,
} from "../computer-access/companion/broker-client.js";
export {
  HOST_OPERATIONS,
  type HostIdentity,
  type HostOperation,
  type HostStatus,
  isHostIdentifier,
  isHostIdentity,
  isHostOperation,
} from "../computer-access/companion/protocol.js";
export {
  computerFields,
  computerInputError,
  computerRecord,
  computerText,
  readNativeComputerAction,
  readPhysicalRectangle,
} from "../computer-access/computer/action-input.js";
export { createCompanionComputerBackend } from "../computer-access/computer/companion-backend.js";
export { withDesktopQueue } from "../computer-access/computer/desktop-action-queue.js";
export { createNativeComputerBackend } from "../computer-access/computer/native-backend.js";
export {
  type NativeComputerAction,
  type NativeComputerBackend,
  type NativeComputerObservation,
  type NativeComputerResult,
  type PhysicalPoint,
  type PhysicalRectangle,
} from "../computer-access/computer/native-protocol.js";
export {
  COMPUTER_CAPABILITY,
  readNativeComputerResult,
} from "../computer-access/computer/native-validation.js";
export {
  SystemOperationError,
  type SystemTarget,
  type SystemTargetId,
} from "../computer-access/contracts.js";
export { createSystemHandlers } from "../computer-access/handlers.js";
export {
  type SystemTargetObservation,
  observeSystemTargets,
} from "../computer-access/target-observation.js";
export type {
  ComputerAccessConnection,
  CompanionTarget,
} from "../computer-access/client.js";

export { runSystemProcess } from "../computer-access/process-runner.js";
export { buildSystemProcessResult } from "../computer-access/process-result.js";
export type { SystemCommandOutputFactory } from "../computer-access/command-output.js";
export type { SystemProcessCapture } from "../computer-access/process-capture.js";
export type { SystemProcessResult } from "../computer-access/contracts.js";

export { createSystemOutputCapture, type SystemOutputReceipt } from "../computer-access/command-output-capture.js";
export { DEFAULT_SYSTEM_OUTPUT_RETENTION_MS, scheduleSystemOutputCleanup } from "../computer-access/command-output-retention.js";
export { SYSTEM_OUTPUT_CAPABILITY, SYSTEM_OUTPUT_CHUNK_BYTES, readSystemOutputTransfer } from "../computer-access/companion/command-output-protocol.js";
