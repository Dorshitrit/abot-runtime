import type { SessionComposerQueueItem, ReleasedSessionComposerQueueItem } from "../lib/session-composer-queue.js";
import type { ComposerAttachment, ComposerDraft, ComposerDraftSnapshot, ComposerDrafts, ComposerScope } from "./composer-drafts.js";

export type ComposerSubmissionAction = "send" | "send_next" | "steer";
export type ComposerSubmissionSettings = Pick<SessionComposerQueueItem, "agentMode" | "toolPermissionMode" | "modelPreference" | "reasoningPreference">;
export type ComposerSubmissionPhase = "preparing" | "sending" | "accepted" | "refused" | "uncertain" | "restored";

export interface ComposerSubmissionAttempt<Settings = unknown, Result = unknown> {
  readonly id: number;
  readonly action: ComposerSubmissionAction;
  readonly settings: Settings;
  readonly payload: ComposerDraftSnapshot;
  phase: ComposerSubmissionPhase;
  error: unknown;
  result?: Result;
}

export type ComposerSubmissionResult<Settings = unknown, Result = unknown> =
  | { status: "accepted"; attempt: ComposerSubmissionAttempt<Settings, Result>; result: Result; bookkeepingError?: unknown }
  | { status: "refused" | "uncertain"; attempt: ComposerSubmissionAttempt<Settings, Result>; error: unknown };

export type ComposerReviewAuthorization = boolean | { release: ReleasedSessionComposerQueueItem };
export interface ComposerSubmissionOptions<Settings = unknown, Result = unknown> {
  action: ComposerSubmissionAction;
  settings?: Settings;
  prepare?(attempt: ComposerSubmissionAttempt<Settings, Result>): void | Promise<void>;
  execute(attempt: ComposerSubmissionAttempt<Settings, Result>): Result | Promise<Result>;
  accepted?(attempt: ComposerSubmissionAttempt<Settings, Result>, result: Result): void | Promise<void>;
  prepareRestore?(attempt: ComposerSubmissionAttempt<Settings, Result>): ComposerDraftSnapshot | Promise<ComposerDraftSnapshot>;
}

export interface ComposerSubmissionLifecycle {
  submit<Settings = unknown, Result = unknown>(options: ComposerSubmissionOptions<Settings, Result> & { draft: ComposerDraft }): Promise<ComposerSubmissionResult<Settings, Result>>;
  submitCaptured<Settings = unknown, Result = unknown>(options: ComposerSubmissionOptions<Settings, Result> & { payload: ComposerDraftSnapshot }): Promise<ComposerSubmissionResult<Settings, Result>>;
  hasPendingScope(scope: ComposerScope): boolean;
  restoreForManualReview(id: number, authorize: (attempt: ComposerSubmissionAttempt) => ComposerReviewAuthorization | Promise<ComposerReviewAuthorization>): Promise<boolean>;
  paused(scope: ComposerScope): ComposerSubmissionAttempt[];
  ownsAttachment(attachment: ComposerAttachment): boolean;
}

export declare class ComposerSubmissionRefused extends Error {
  constructor(message: string, options?: ErrorOptions);
}
export declare function isDefiniteSubmissionRefusal(error: unknown): error is ComposerSubmissionRefused;
export declare function createComposerSubmissionLifecycle(options: {
  drafts: ComposerDrafts;
  onChange?(attempt: ComposerSubmissionAttempt): void;
}): ComposerSubmissionLifecycle;
