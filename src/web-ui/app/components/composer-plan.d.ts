import type { ComposerPlanModel } from "../lib/composer-plan-model.js";

export declare function createComposerPlan(options?: {
  container?: HTMLElement | null;
  documentRoot?: Document;
}): {
  render(model: ComposerPlanModel | null): void;
  reset(): void;
};
