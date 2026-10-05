import type { AutomationJsonValue } from "./definition-contracts.js";

export type StarterToolStep = Readonly<{
  kind: "tool";
  key: string;
  title: string;
  toolName: string;
  operationId: string;
  controls?: Readonly<Record<string, AutomationJsonValue>>;
  controlInputs?: Readonly<Record<string, string>>;
  effect?: "mutating";
  payloadFrom?: string;
  outputFile?: string;
}>;

export type StarterAgentStep = Readonly<{
  kind: "agent";
  key: string;
  title: string;
  role: string;
  prompt: string;
  sources: readonly string[];
  parallelSources?: readonly string[];
  runInputs?: readonly string[];
}>;

export type StarterParallelStep = Readonly<{
  kind: "parallel";
  key: string;
  branches: readonly (readonly StarterStep[])[];
}>;

export type StarterStep = StarterToolStep | StarterAgentStep | StarterParallelStep;

export type AutomationStarter = Readonly<{
  id: string;
  title: string;
  category: string;
  description: string;
  setup: string;
  objective: string;
  level?: "advanced";
  highlights?: readonly string[];
  inputs?: Readonly<Record<string, AutomationJsonValue>>;
  maxModelCallsPerRun?: number;
  steps: readonly StarterStep[];
}>;
