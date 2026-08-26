import { MODEL_STEPS, type ModelStep } from "../../../shared/model-steps.js";

/** Every model step invoked by runtime and therefore requiring both policy and timeout config. */
export const REQUEST_INVOKED_STEP_IDS: readonly ModelStep[] =
  Object.values(MODEL_STEPS);

export const REQUEST_STEP_INSTRUCTION_REF_MAX_COUNT = 8;
export const REQUEST_STEP_INSTRUCTION_MAX_LENGTH = 32_000;
export const REQUEST_STEP_INSTRUCTIONS_MAX_LENGTH = 48_000;

export type RequestStepInstructionBlock = Readonly<{
  ref: string;
  content: string;
  contentHash: string;
}>;

export type RequestStepConfig = {
  timeoutMs: number;
  instructionBlocks?: readonly RequestStepInstructionBlock[];
};

export type RequestContextConfig = {
  outputReserveTokens: number;
  safetyReserveTokens: number;
  attachmentReserveTokens: number;
};

export type RequestRunnerConfig = {
  models: {
    defaults: {
      profileId: string;
      steps: Record<string, string>;
    };
  };
  context: RequestContextConfig;
  steps: Record<string, RequestStepConfig>;
};
