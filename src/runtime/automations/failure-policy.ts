export type AutomationFailureDisposition =
  | Readonly<{ kind: "skip"; reason: "definite_failure" }>
  | Readonly<{ kind: "stop"; reason: "definite_failure" | "effect_uncertain" }>;

export function decideAutomationFailureDisposition(
  configured: "stop" | "skip",
  settlement: "definite_failure" | "effect_uncertain",
): AutomationFailureDisposition {
  if (settlement === "effect_uncertain") {
    return { kind: "stop", reason: "effect_uncertain" };
  }
  if (configured === "skip") {
    return { kind: "skip", reason: "definite_failure" };
  }
  return { kind: "stop", reason: "definite_failure" };
}
