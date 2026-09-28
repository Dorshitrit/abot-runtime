import type { ObservationMemorySource } from "../observation-contracts.js";
import type { LearningKnowledgeEntry } from "./contracts.js";

/** Bound by the runtime, never supplied by the authoring model. */
export type ConversationMemoryEvidence = Readonly<{
  sourceSessionId: string;
  sourceRequestId: string;
  observedAt: string;
  evidenceDigest: string;
}>;

export type ConversationMemorySource = ConversationMemoryEvidence & Readonly<{
  kind: "passive_response";
  reason: string;
  certainty: "observed" | "inferred";
}>;

export type LearningMemorySource = ObservationMemorySource | ConversationMemorySource;

/** Bounded independent opportunities, not a count of captures or model calls. */
export type LearningReinforcement = Readonly<{ key: string; observedAt: string }>;

export type ConversationMemoryAssessment = Readonly<{
  score: number;
  reason: string;
  reinforced: boolean;
  /** Set only after a model quote is bound to this request's user-authored text. */
  explicitlyRequested?: boolean;
  evidence: ConversationMemoryEvidence;
  target?: LearningKnowledgeEntry;
}>;

export type LearningMemoryReplacement = Readonly<{ id: string; version: string }>;
