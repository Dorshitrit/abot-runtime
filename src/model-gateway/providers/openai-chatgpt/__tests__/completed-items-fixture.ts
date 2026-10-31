export const observedDecision = { action: "respond", response: "שלום! איך אפשר לעזור?", title: "ברכה" };
export const observedArguments = JSON.stringify({ decision: observedDecision });
export const observedResponseId = "resp_siwc_fixture";

/** Sanitized shape of the observed SIWC stream: finalized item, empty terminal output. */
export function completedItemEvents(
  argumentsText = observedArguments,
  name = "execution_agent_decision",
): Record<string, unknown>[] {
  const item = { type: "function_call", id: "fc_siwc_fixture", call_id: "call_siwc_fixture", name };
  let sequence = 0;
  return [
    { type: "response.created", sequence_number: sequence++, response: {
      id: observedResponseId, status: "in_progress", output: [],
    } },
    { type: "response.in_progress", sequence_number: sequence++, response: {
      id: observedResponseId, status: "in_progress", output: [],
    } },
    { type: "response.output_item.added", sequence_number: sequence++, output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" } },
    ...Array.from({ length: 24 }, (_, index) => ({
      type: "response.function_call_arguments.delta", sequence_number: sequence++,
      item_id: item.id, output_index: 0,
      delta: argumentsText.slice(Math.floor(index * argumentsText.length / 24), Math.floor((index + 1) * argumentsText.length / 24)),
    })),
    { type: "response.function_call_arguments.done", sequence_number: sequence++,
      item_id: item.id, output_index: 0, arguments: argumentsText },
    { type: "response.output_item.done", sequence_number: sequence++, output_index: 0,
      item: { ...item, status: "completed", arguments: argumentsText } },
    { type: "response.completed", sequence_number: sequence++, response: {
      id: observedResponseId, status: "completed", output: [], error: null, incomplete_details: null,
    } },
  ];
}
