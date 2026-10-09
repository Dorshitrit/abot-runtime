import type { ToolExecutionContext, ToolImplementationOutput } from "../plugin-sdk/index.js";
import type { SystemProcessResult, SystemProcessRunner, SystemTarget } from "./contracts.js";

/** Allocated per command; probes and companion calls retain their existing runner. */
export type SystemCommandOutputFactory = (context?: ToolExecutionContext) => Readonly<{
  run: SystemProcessRunner;
  present(target: SystemTarget, result: SystemProcessResult): Promise<ToolImplementationOutput>;
}>;
