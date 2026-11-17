import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import { createRequestModelPolicy } from "../config/runner/model-policy.js";
import { resolveModelSelection } from "../model/model-selection.js";
import type { RuntimeConfig } from "../ports.js";
import type { AgentNode } from "./definition-contracts.js";

/** Admission uses platform defaults; the actual request uses the runner's defaults. */
export function createAutomationAgentModelSelection(config: RuntimeConfig) {
  const configPath = config.requestRunner?.configPath;
  const runnerConfig = configPath ? loadRequestRunnerConfig({ configPath }) : undefined;
  const modelPolicy = runnerConfig
    ? createRequestModelPolicy({ platformPolicy: config.models, runnerConfig })
    : config.models;
  const request = (node: AgentNode) => ({
    agentMode: node.agentMode,
    modelPreference: { profileId: node.modelProfileId, scope: "all" },
    modelExecutionPolicies: config.modelExecutionPolicies,
  });
  return {
    runnerConfig,
    modelPolicy,
    admission: (node: AgentNode) => resolveModelSelection({
      ...request(node), modelPolicy: config.models,
    }),
    execution: (node: AgentNode) => resolveModelSelection({ ...request(node), modelPolicy }),
  };
}
