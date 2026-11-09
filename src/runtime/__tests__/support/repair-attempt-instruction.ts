/** Read the final instruction before the original conversational turns in a repair invocation. */
export function readOpeningRepairInstruction<T extends { role: string }>(messages: readonly T[]): T {
  let instruction: T | undefined;
  for (const message of messages) {
    if (message.role !== "system") break;
    instruction = message;
  }
  if (!instruction) throw new Error("test_repair_attempt_opening_instruction_missing");
  return instruction;
}
