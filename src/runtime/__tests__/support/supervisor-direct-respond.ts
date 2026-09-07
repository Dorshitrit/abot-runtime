import type { SupervisorRespondDecision } from "../../steps/supervisor-decision/contracts.js";

/** A complete initial respond fixture; resumed decisions omit the recommendation. */
export function directRespondDecision(
  fields: Omit<SupervisorRespondDecision, "action"> = {},
): SupervisorRespondDecision {
  return {
    action: "respond",
    ...fields,
    responseRecommendation:
      fields.responseRecommendation ??
      "Present the established answer and include any stated limitations.",
  };
}

export function directRespondText(
  acknowledgement?: string,
  title?: string,
): string {
  return JSON.stringify({
    decision: directRespondDecision({ acknowledgement, title }),
  });
}
