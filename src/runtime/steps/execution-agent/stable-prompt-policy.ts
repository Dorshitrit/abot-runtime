import { buildRespondDecisionInstruction } from "./direct-response-prompt.js";
import { buildMemoryRecallDecisionInstructions } from "../memory-recall-prompt.js";
import type { ExecutionAgentInstructionOptions } from "./prompt.js";

type BooleanOption = {
  [Key in keyof ExecutionAgentInstructionOptions]-?:
    ExecutionAgentInstructionOptions[Key] extends boolean | undefined ? Key : never;
}[keyof ExecutionAgentInstructionOptions];
type PolicyAlternative = Readonly<{
  applies: boolean;
  instructions: readonly string[];
}>;

/** The runtime selects applicable policy; stable transport guidance never changes selection. */
export function createExecutionInstructionPolicy(options: ExecutionAgentInstructionOptions) {
  const stable = options.stableContract === true;
  const alternatives = (choices: readonly PolicyAlternative[]): string[] =>
    choices.flatMap((choice) => choice.applies ? [...choice.instructions] : []);
  const boolean = (
    field: Exclude<BooleanOption, "stableContract">,
    enabled: readonly string[],
    disabled: readonly string[] = [],
  ) => alternatives([
    { applies: options[field] === true, instructions: enabled },
    { applies: options[field] !== true, instructions: disabled },
  ]);
  return {
    contractInstructions: stable ? [
      "The wire schema defines syntax, not availability. Select only actions and capabilities offered by the current runtime contract; its limits are enforced before execution.",
      "Offered fields retain their documented required, optional and null semantics; null cannot replace a required offered value. Existing null meanings for an agent-root workingDirectory, no interaction update and an intentionally omitted optional selectionControl remain unchanged.",
    ] : [],
    boolean,
    scopeAction: (open: string, extend: string, unavailable: string) => alternatives([
      { applies: options.capabilityScopeAction === "open", instructions: [open] },
      { applies: options.capabilityScopeAction === "extend", instructions: [extend] },
      { applies: options.capabilityScopeAction === null, instructions: [unavailable] },
    ]),
    audit: (offered: string, unavailable: string) => alternatives([
      { applies: options.availableAuditCriterionCount > 0, instructions: [offered] },
      { applies: options.availableAuditCriterionCount <= 0, instructions: [unavailable] },
    ]),
    memoryRecall: () => alternatives([
      { applies: options.allowMemoryRecall === true,
        instructions: buildMemoryRecallDecisionInstructions(true, false) },
      { applies: options.allowMemoryRecall !== true && options.hasMemoryRecallContext === true,
        instructions: buildMemoryRecallDecisionInstructions(false, true) },
    ]),
    respond: () => alternatives([
      { applies: !options.allowRespond,
        instructions: [buildRespondDecisionInstruction({ allowRespond: false })] },
      { applies: options.allowRespond && options.allowDirectResponse === true,
        instructions: [buildRespondDecisionInstruction({ allowRespond: true, allowDirectResponse: true })] },
      { applies: options.allowRespond && options.allowDirectResponse !== true,
        instructions: [buildRespondDecisionInstruction({ allowRespond: true, allowDirectResponse: false })] },
    ]),
  };
}
