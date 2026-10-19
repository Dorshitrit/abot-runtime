export type CapabilityExecutionGuidanceEntry = Readonly<{
  slot: string;
  capabilityId: string;
  guidance: string;
}>;

type CapabilityExecutionGuidanceGroup<T> = {
  guidance: string;
  invocations: T[];
};

/** Deduplicates complete guidance bodies only within this prompt projection. */
export function buildBatchCapabilityExecutionGuidance<
  T extends CapabilityExecutionGuidanceEntry,
>(
  invocations: readonly T[],
  renderSingleInvocation: (invocation: T) => readonly string[],
): readonly string[] {
  const groups: CapabilityExecutionGuidanceGroup<T>[] = [];
  const groupsByGuidance = new Map<
    string,
    CapabilityExecutionGuidanceGroup<T>
  >();
  for (const invocation of invocations) {
    const existing = groupsByGuidance.get(invocation.guidance);
    if (existing) {
      existing.invocations.push(invocation);
      continue;
    }
    const group = { guidance: invocation.guidance, invocations: [invocation] };
    groups.push(group);
    if (invocation.guidance.length > 0) {
      groupsByGuidance.set(invocation.guidance, group);
    }
  }
  return Object.freeze(
    groups.flatMap(({ guidance, invocations: recipients }) => {
      if (recipients.length === 1) {
        return renderSingleInvocation(recipients[0]!);
      }
      return [
        "### SHARED CAPABILITY EXECUTION GUIDANCE",
        `Applies only to: ${recipients.map(({ slot, capabilityId }) => `${slot} (${capabilityId})`).join(", ")}.`,
        guidance,
        "### END SHARED CAPABILITY EXECUTION GUIDANCE",
      ];
    }),
  );
}
