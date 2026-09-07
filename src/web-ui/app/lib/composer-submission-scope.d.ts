export interface ComposerSubmissionView {
  currentSessionId: string;
  sessionViewVersion?: number;
}

export interface ComposerSubmissionScope {
  environmentId: string;
  sessionId: string;
  viewVersion: number | undefined;
}

export declare function captureComposerSubmissionScope(
  state: ComposerSubmissionView,
  environmentId: string,
): ComposerSubmissionScope;

export declare function isCurrentComposerSubmissionScope(
  scope: ComposerSubmissionScope,
  state: ComposerSubmissionView,
  environmentId: string,
): boolean;
