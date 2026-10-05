export type AutomationLimits = Readonly<{
  maxConcurrentNodes: number;
  maxModelCallsPerRun: number;
  maxToolCallsPerRun: number;
  maxRunDurationMs: number;
  maxRunsPerDay: number;
  maxStoredArtifactBytes: number;
  stopReportDeadlineMs: number;
}>;

export const AUTOMATION_GRAPH_LIMITS = Object.freeze({
  executableNodes: 64,
  branchesPerGroup: 8,
  nestingDepth: 4,
  sourceFilesPerBatch: 100,
  sourceBatchBytes: 32 * 1024 * 1024,
  eligibleInputRecords: 1_000,
  inputMetadataBytes: 32 * 1024 * 1024,
});

export const AUTOMATION_OUTPUT_SCHEMA_LIMITS = Object.freeze({
  maxProperties: 16,
  maxStringLength: 4_096,
  maxArrayItems: 64,
});

export const DEFAULT_AUTOMATION_LIMITS: AutomationLimits = Object.freeze({
  maxConcurrentNodes: 2,
  maxModelCallsPerRun: 24,
  maxToolCallsPerRun: 64,
  maxRunDurationMs: 30 * 60 * 1_000,
  maxRunsPerDay: 24,
  maxStoredArtifactBytes: 256 * 1024 * 1024,
  stopReportDeadlineMs: 30 * 1_000,
});

export function validateAutomationLimits(limits: AutomationLimits): string[] {
  const issues: string[] = [];
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      issues.push(`${name} must be a positive safe integer`);
    }
  }
  if (limits.maxConcurrentNodes > AUTOMATION_GRAPH_LIMITS.executableNodes) {
    issues.push("maxConcurrentNodes exceeds the graph node ceiling");
  }
  if (limits.stopReportDeadlineMs > limits.maxRunDurationMs) {
    issues.push("stopReportDeadlineMs exceeds maxRunDurationMs");
  }
  if (limits.maxRunDurationMs + limits.stopReportDeadlineMs > 2_147_483_647) {
    issues.push("The run and stop deadlines exceed the supported timer range");
  }
  return issues;
}
