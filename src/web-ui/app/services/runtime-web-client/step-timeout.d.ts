export type StepTimeoutIdentity = Readonly<{
  environment: string;
  sessionId: string;
  requestId: string;
  invocationId: string;
}>;
export type StepTimeoutSuggestion = Readonly<{
  configurationProfileId?: string;
  profileId: string;
  model: string;
  modelStep: string;
  calibrationSlotId?: string;
  timeoutMs: number;
  proposedTimeoutMs: number;
  canIncrease: boolean;
  reason?: string;
  revision?: string;
}>;
export type StepTimeoutRequests = {
  inspectStepTimeout(identity: StepTimeoutIdentity): Promise<{ ok: true; suggestion: StepTimeoutSuggestion }>;
  increaseStepTimeout(identity: StepTimeoutIdentity, expectedRevision: string): Promise<{
    ok: true;
    status: "saved" | "already_saved";
    timeoutMs: number;
  }>;
};
