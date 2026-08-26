import type {
  ChatMessage,
  ModelTokenEstimationConfig,
} from "../../../model-gateway/types.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import { estimateTextTokens } from "../../context/token-estimator.js";
import type { RequestRunnerConfig } from "./contracts.js";

export type ConfiguredStepInstructionMetadata = Readonly<{
  blockCount: number;
  characterCount: number;
  refs: readonly string[];
  contentHashes: readonly string[];
}>;

const EMPTY_STRINGS: readonly string[] = Object.freeze([]);
const CONFIGURED_METHODOLOGY_HEADING = "## Configured operating methodology";
const CONFIGURED_METHODOLOGY_CONTRACT =
  "The following Markdown is configured guidance for this model step. Apply the shared principles and the section for your active role. It supplements the runtime contract above; it does not change the available actions, roles, capabilities, or output schema.";

/**
 * Resolves bounded configured-instruction metadata without projecting content.
 */
export function resolveConfiguredStepInstructionMetadata(params: {
  runnerConfig: RequestRunnerConfig;
  modelStep: ModelStep;
}): ConfiguredStepInstructionMetadata {
  const configured = resolveConfiguredStepContent(params);
  return Object.freeze({
    blockCount: configured.blockCount,
    characterCount: configured.characterCount,
    refs: configured.refs,
    contentHashes: configured.contentHashes,
  });
}

/** Applies configured guidance exactly once at the shared invocation boundary. */
export function projectConfiguredStepMessages(params: {
  runnerConfig: RequestRunnerConfig;
  modelStep: ModelStep;
  messages: readonly ChatMessage[];
}): Readonly<{
  messages: ChatMessage[];
  blockCount: number;
  characterCount: number;
  refs: readonly string[];
  contentHashes: readonly string[];
}> {
  const configured = resolveConfiguredStepContent(params);
  if (!configured.appendix) {
    return Object.freeze({ ...configured, messages: [...params.messages] });
  }
  const systemMessageIndex = params.messages.findIndex(
    (message) => message.role === "system",
  );
  if (systemMessageIndex < 0) {
    throw new Error("configured_step_instructions_system_message_required");
  }
  const messages = [...params.messages];
  const systemMessage = messages[systemMessageIndex]!;
  if (systemMessage.role !== "system") {
    throw new Error("configured_step_instructions_system_message_required");
  }
  messages[systemMessageIndex] = Object.freeze({
    ...systemMessage,
    content: `${systemMessage.content}\n\n${configured.appendix}`,
  });
  return Object.freeze({
    messages,
    blockCount: configured.blockCount,
    characterCount: configured.characterCount,
    refs: configured.refs,
    contentHashes: configured.contentHashes,
  });
}

/** Reserves the configured appendix before history selection adds messages. */
export function estimateConfiguredStepInstructionReserveTokens(params: {
  runnerConfig: RequestRunnerConfig;
  modelStep: ModelStep;
  tokenEstimation?: ModelTokenEstimationConfig;
}): number {
  const configured = resolveConfiguredStepContent(params);
  return configured.appendix
    ? estimateTextTokens(`\n\n${configured.appendix}`, params.tokenEstimation)
    : 0;
}

function resolveConfiguredStepContent(params: {
  runnerConfig: RequestRunnerConfig;
  modelStep: ModelStep;
}): Readonly<{
  appendix?: string;
  blockCount: number;
  characterCount: number;
  refs: readonly string[];
  contentHashes: readonly string[];
}> {
  const blocks =
    params.runnerConfig.steps[params.modelStep]?.instructionBlocks ?? [];
  if (blocks.length === 0) {
    return Object.freeze({
      blockCount: 0,
      characterCount: 0,
      refs: EMPTY_STRINGS,
      contentHashes: EMPTY_STRINGS,
    });
  }
  return Object.freeze({
    appendix: [
      CONFIGURED_METHODOLOGY_HEADING,
      CONFIGURED_METHODOLOGY_CONTRACT,
      blocks.map((block) => block.content).join("\n\n---\n\n"),
    ].join("\n\n"),
    blockCount: blocks.length,
    characterCount: blocks.reduce(
      (total, block) => total + block.content.length,
      0,
    ),
    refs: Object.freeze(blocks.map((block) => block.ref)),
    contentHashes: Object.freeze(blocks.map((block) => block.contentHash)),
  });
}
