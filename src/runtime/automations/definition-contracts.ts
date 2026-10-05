import type { ToolNormalInvocationInput } from "../../capabilities/normal-invocation/contracts.js";
import type { AgentMode } from "../../shared/types.js";
import type { CapabilityJsonValue } from "../orchestration/capability-adapters/result.js";
import type { SchedulerScheduleInput } from "../scheduler/contracts.js";
import type { AutomationLimits } from "./limits.js";

export type AutomationJsonValue = CapabilityJsonValue;
export type AutomationOutputSchema = ToolNormalInvocationInput;

export type AutomationTrigger =
  | Readonly<{ kind: "manual" }>
  | Readonly<{ kind: "schedule"; schedule: SchedulerScheduleInput }>
  | Readonly<{
      kind: "folder";
      checkEveryMs: number;
      minimumEligibleFiles: number;
    }>;

export type FolderSource = Readonly<{
  sourceId: string;
  location: Readonly<{ kind: "runtime_path"; path: string }>;
  includePatterns: readonly string[];
  excludePatterns: readonly string[];
  recursive: boolean;
  includeExisting: boolean;
  mode: "per_file" | "batch";
  maxBatchFiles: number;
}>;

export type OperationRef = Readonly<{
  toolName: string;
  operationId: string;
  contractVersion: number;
}>;

export type ValueBinding =
  | Readonly<{ kind: "literal"; value: AutomationJsonValue }>
  | Readonly<{ kind: "run_input"; input: string }>
  | Readonly<{ kind: "run_file"; fileName: string }>
  | Readonly<{ kind: "source_files" }>
  | Readonly<{
      kind: "source_file";
      index: number;
      field: "snapshot_path" | "original_path" | "version";
    }>
  | Readonly<{
      kind: "node_result";
      nodeId: string;
      select: "text" | "data";
      pointer?: string;
    }>
  | Readonly<{ kind: "branch_results"; parallelNodeId: string }>;

export type AutomationNodeBase = Readonly<{
  id: string;
  title: string;
  onFailure: "stop" | "skip";
}>;

export type ToolNode = AutomationNodeBase &
  Readonly<{
    kind: "tool";
    operation: OperationRef;
    controls: Readonly<Record<string, ValueBinding>>;
    payload?: ValueBinding;
  }>;

export type AgentNode = AutomationNodeBase &
  Readonly<{
    kind: "agent";
    modelProfileId: string;
    agentMode: AgentMode;
    roleInstructions: string;
    prompt: string;
    inputs: Readonly<Record<string, ValueBinding>>;
    tools: readonly Readonly<{
      operation: OperationRef;
      usage: "available" | "required";
    }>[];
    result: Readonly<{ kind: "text" }> | Readonly<{
      kind: "json";
      schema: AutomationOutputSchema;
    }>;
    acceptance?: readonly Readonly<{
      field: string;
      equals: string | number | boolean;
    }>[];
    savedAgentOrigin?: Readonly<{ agentId: string; revision: number }>;
  }>;

export type SequenceNode = Readonly<{
  kind: "sequence";
  id: string;
  children: readonly WorkflowNode[];
}>;

export type ParallelNode = Readonly<{
  kind: "parallel";
  id: string;
  branches: readonly SequenceNode[];
}>;

export type WorkflowNode = SequenceNode | ParallelNode | AgentNode | ToolNode;

export type AutomationRevision = Readonly<{
  schemaVersion: 1;
  automationId: string;
  revision: number;
  title: string;
  objective: string;
  workingDirectory?: string;
  trigger: AutomationTrigger;
  source?: FolderSource;
  inputs: Readonly<Record<string, AutomationJsonValue>>;
  body: SequenceNode;
  limits: AutomationLimits;
}>;

export type SourceFileSnapshot = Readonly<{
  inputId: string;
  sourceId: string;
  originalPath: string;
  snapshotPath: string;
  version: string;
  sizeBytes: number;
}>;
