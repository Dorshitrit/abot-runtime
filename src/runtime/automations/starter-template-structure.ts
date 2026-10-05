import type { StarterStep, StarterToolStep } from "./starter-template-contracts.js";

/** One traversal for recipe availability, counts and output discovery. */
export function walkStarterSteps(steps: readonly StarterStep[]): StarterStep[] {
  return steps.flatMap((step) => {
    if (step.kind !== "parallel") return [step];
    return [step, ...step.branches.flatMap(walkStarterSteps)];
  });
}

export function isStarterToolStep(step: StarterStep): step is StarterToolStep {
  return step.kind === "tool";
}
