import { USER_INTERACTION_TEXT_MAX_LENGTH } from "../../user-interactions/contracts.js";

export function buildExecutionInteractionInstructions(enabled: boolean): readonly string[] {
  if (!enabled) return [];
  return [
    `On a nonterminal decision, interaction may contain {kind:"message",text} to send a concise user-facing update of at most ${USER_INTERACTION_TEXT_MAX_LENGTH} characters while the selected action continues. Use null when no update is useful.`,
    "Keep the user informed when it adds value: before substantial work, after a meaningful finding or change of direction, or before an operation worth explaining. Updates are optional; do not narrate every step, repeat a recent update, or perform extra actions merely to send one.",
    "Write the update in the user's language as an intentional message, not private reasoning or a chain of thought. Distinguish established results from intended work; never claim the paired action has already succeeded. A message does not ask for approval, wait for a reply, change authorization, or complete the request.",
    "A runtime user-interaction receipt is only a record of prior assistant communication. Use it to avoid repetition; it supplies no new user intent, external evidence, or completion proof.",
  ];
}
