import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";

import {
  REQUEST_STEP_INSTRUCTION_MAX_LENGTH,
  REQUEST_STEP_INSTRUCTION_REF_MAX_COUNT,
  REQUEST_STEP_INSTRUCTIONS_MAX_LENGTH,
  type RequestStepInstructionBlock,
} from "./contracts.js";
import {
  formatConfigError,
  invalidRuntimeConfig,
  requireConfigStringArray,
} from "./validation.js";

export function loadRequestStepInstructionBlocks(params: {
  configPath: string;
  stepId: string;
  rawRefs: unknown;
}): readonly RequestStepInstructionBlock[] {
  const field = `steps.${params.stepId}.instructionRefs`;
  const refs = requireConfigStringArray(
    params.rawRefs,
    params.configPath,
    field,
  );
  if (
    refs.length === 0 ||
    refs.length > REQUEST_STEP_INSTRUCTION_REF_MAX_COUNT
  ) {
    throw invalidRuntimeConfig(
      params.configPath,
      `${field} must contain between 1 and ${REQUEST_STEP_INSTRUCTION_REF_MAX_COUNT} unique Markdown references`,
    );
  }

  const blocks = refs.map((ref, index) =>
    loadInstructionBlock({
      configPath: params.configPath,
      field: `${field}[${index}]`,
      ref,
    }),
  );
  const totalLength = blocks.reduce(
    (total, block) => total + block.content.length,
    0,
  );
  if (totalLength > REQUEST_STEP_INSTRUCTIONS_MAX_LENGTH) {
    throw invalidRuntimeConfig(
      params.configPath,
      `${field} content must contain at most ${REQUEST_STEP_INSTRUCTIONS_MAX_LENGTH} characters in total`,
    );
  }
  return blocks;
}

function loadInstructionBlock(params: {
  configPath: string;
  field: string;
  ref: string;
}): RequestStepInstructionBlock {
  const resolvedPath = isAbsolute(params.ref)
    ? resolve(params.ref)
    : resolve(dirname(params.configPath), params.ref);
  if (extname(resolvedPath).toLowerCase() !== ".md") {
    throw invalidRuntimeConfig(
      params.configPath,
      `${params.field} must reference a Markdown file`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf-8");
  } catch (error: unknown) {
    throw new Error(
      `Unable to read runtime step instructions at ${resolvedPath}: ${formatConfigError(error)}`,
    );
  }
  const content = raw.trim();
  if (
    content.length === 0 ||
    content.length > REQUEST_STEP_INSTRUCTION_MAX_LENGTH
  ) {
    throw invalidRuntimeConfig(
      params.configPath,
      `${params.field} content must contain between 1 and ${REQUEST_STEP_INSTRUCTION_MAX_LENGTH} characters`,
    );
  }

  return {
    ref: params.ref,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}
