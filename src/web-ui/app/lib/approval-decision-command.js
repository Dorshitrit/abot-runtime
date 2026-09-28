export function approvalDecisionCommand(approval, approved) {
  if (
    !approval.generation ||
    !approval.waitId ||
    !Number.isSafeInteger(approval.revision)
  )
    return {};
  return {
    generation: approval.generation,
    waitId: approval.waitId,
    revision: approval.revision,
    commandId: `approval:${JSON.stringify([approval.generation, approval.waitId, approval.approvalId, approved])}`,
  };
}
