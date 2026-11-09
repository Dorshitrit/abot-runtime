import type { ToolNormalInvocationInput, ToolNormalInvocationOperation } from "../../../capabilities/tool-types.js";
import { AUTHORING_CONTEXT_LIMITS as limits } from "../authoring-context/contracts.js";
import { homeGenerationFailure, type SparkHomeReadDescriptor, type SparkHomeReadPlanning,
  type SparkHomeResourceReadBudgetReference } from "./contracts.js";

export const SPARK_HOME_RESOURCE_READ_OPERATION = "information_basket:read_information_source";
export function isSparkHomeResourceRead(operationId: string): boolean {
  return operationId === SPARK_HOME_RESOURCE_READ_OPERATION;
}

/** One run-local owner binds the advertised Resource budget to exact prepared controls. */
export function createSparkHomeResourceReadBudget(operation?: ToolNormalInvocationOperation) {
  let consumedReads = 0;
  let consumedCharacters = 0;
  const upstream = operation?.input.properties.maxChars;
  const upstreamMaximum = upstream?.type === "integer" ? upstream.maximum : 0;
  const upstreamMinimum = upstream?.type === "integer" ? upstream.minimum : 1;

  function captureResourceReadBudget(): SparkHomeResourceReadBudgetReference {
    const remainingReads = limits.resourceInspections - consumedReads;
    const remainingCharacters = limits.totalResourceCharacters - consumedCharacters;
    const maximum = Math.min(limits.resourceCharacters, remainingCharacters, upstreamMaximum);
    const maxCharactersPerRead = hasResourceReadCapacity(remainingReads, maximum) ? maximum : 0;
    return Object.freeze({ kind: "spark_home_resource_read_budget_v1", authority: "passive_runtime_state",
      applicability: "this_home_planning_phase_only", addsUserIntent: false, grantsActionAuthority: false,
      remainingReads, remainingCharacters, maxCharactersPerRead,
      defaultCharactersPerRead: Math.min(2000, maxCharactersPerRead) });
  }

  function hasResourceReadCapacity(remainingReads: number, maximum: number): boolean {
    if (remainingReads < 1) return false;
    if (maximum < Math.max(1, upstreamMinimum)) return false;
    return true;
  }

  function assertResourceReadFitsBudget(maxChars: unknown, budget: SparkHomeResourceReadBudgetReference): asserts maxChars is number {
    if (!Number.isSafeInteger(maxChars)) return homeGenerationFailure("spark_home_resource_read_limit");
    if (Number(maxChars) < Math.max(1, upstreamMinimum)) return homeGenerationFailure("spark_home_resource_read_limit");
    if (Number(maxChars) > budget.maxCharactersPerRead) return homeGenerationFailure("spark_home_resource_read_limit");
  }

  return {
    planning(descriptors: readonly SparkHomeReadDescriptor[]): SparkHomeReadPlanning {
      const resourceReadBudget = captureResourceReadBudget();
      const operations = descriptors.flatMap(descriptor => {
        if (!isSparkHomeResourceRead(descriptor.id)) return [descriptor];
        if (!hasResourceReadCapacity(resourceReadBudget.remainingReads, resourceReadBudget.maxCharactersPerRead)) return [];
        const input = descriptor.input as ToolNormalInvocationInput;
        return [{ ...descriptor, input: { ...input, properties: { ...input.properties,
          maxChars: { ...input.properties.maxChars, maximum: resourceReadBudget.maxCharactersPerRead } } } }];
      });
      return { operations: Object.freeze(operations), resourceReadBudget };
    },
    prepareControls(controls: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
      const budget = captureResourceReadBudget();
      const maxChars = controls.maxChars ?? budget.defaultCharactersPerRead;
      assertResourceReadFitsBudget(maxChars, budget);
      return { ...controls, maxChars };
    },
    consume(controls: Readonly<Record<string, unknown>>): void {
      assertResourceReadFitsBudget(controls.maxChars, captureResourceReadBudget());
      consumedReads += 1;
      consumedCharacters += controls.maxChars;
    },
  };
}
