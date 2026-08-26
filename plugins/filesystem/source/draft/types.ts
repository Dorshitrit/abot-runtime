import type { ToolExecutionContext } from "../../../../src/plugin-sdk/index.js";

export type LineRange = Readonly<{ startLine: number; endLine: number }>;

export type DraftDiagnostic = Readonly<{
  code: string;
  message: string;
  offset?: number;
  line?: number;
  column?: number;
  repairScope?: LineRange;
  repairAttemptLimit?: number;
}>;

export type DraftValidator = Readonly<{
  id: string;
  label: string;
  authoritativeStructure: boolean;
  matchesTarget(targetPath: string): boolean;
  validate(content: string, targetPath: string): DraftDiagnostic | undefined;
}>;

export type PreparedDraft = Readonly<{
  content: string;
  validation: "not_applicable" | "valid" | "repaired";
  structuralIntegrity: "unknown" | "validated";
  validatorId?: string;
  changedRange?: LineRange;
}>;

export type PrepareDraftInput = Readonly<{
  targetPath: string;
  candidate: string;
  context?: ToolExecutionContext;
  repairScope?: LineRange;
}>;
