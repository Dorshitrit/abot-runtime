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
