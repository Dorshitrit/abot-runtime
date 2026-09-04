import {
  beginCapabilityBatch,
  settleCapabilityBatch,
} from "./command-dispatch/capability-batch-transitions.js";
import {
  beginCapabilityExecution,
  settleCapabilityExecution,
} from "./command-dispatch/capability-execution-transitions.js";
import { reconsiderCapabilitySelection } from "./command-dispatch/capability-selection-transition.js";
import {
  establishWorkingDirectory,
  updateCapabilityScope,
} from "./command-dispatch/call-scope-transitions.js";
import {
  openChild,
  returnChild,
} from "./command-dispatch/child-transitions.js";
import {
  completeRootResponse,
  createRoot,
} from "./command-dispatch/root-transitions.js";
import type {
  RoleCallLedgerCommand,
  RoleCallPolicy,
  RoleCallState,
  RoleCallTransitionResult,
} from "./contracts.js";

export function dispatchRoleCallCommand(
  state: RoleCallState,
  command: RoleCallLedgerCommand,
  policy: RoleCallPolicy,
  admittedHeadRevision?: number,
): RoleCallTransitionResult {
  switch (command.type) {
    case "create_root":
      return createRoot(state);
    case "complete_root_response":
      return completeRootResponse(state, command, policy);
    case "open_child":
      return openChild(state, command, policy);
    case "return_child":
      return returnChild(state, command, policy, admittedHeadRevision);
    case "begin_capability_execution":
      return beginCapabilityExecution(state, command, policy);
    case "settle_capability_execution":
      return settleCapabilityExecution(state, command, policy);
    case "begin_capability_batch":
      return beginCapabilityBatch(state, command, policy);
    case "settle_capability_batch":
      return settleCapabilityBatch(state, command, policy);
    case "update_capability_scope":
      return updateCapabilityScope(state, command, policy);
    case "establish_working_directory":
      return establishWorkingDirectory(state, command, policy);
    case "reconsider_capability_selection":
      return reconsiderCapabilitySelection(state, command, policy);
  }
}
