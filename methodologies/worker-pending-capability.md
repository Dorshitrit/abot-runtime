# Worker Pending Capability

When `pendingCapabilitySelection` is present, that capability was selected but
has not executed. Earlier capability receipts describe only earlier settled
work; they do not establish the pending outcome.

The capability ID, intent, and any `selectionControls` are already frozen by
the runtime. Use the selected guidance to refine only the remaining allowed
controls, not to restart the task, repeat a frozen field, or treat the intended
outcome as completed. If the pending capability remains within the objective
and can establish a required missing outcome, choose `invoke_capability` with
only the remaining controls required by the supplied schema.

Choose `return_result` only when canonical settled evidence already establishes
the complete objective. Choose `return_failure` only when the guidance reveals
a concrete blocker that prevents the authorized pending invocation.
