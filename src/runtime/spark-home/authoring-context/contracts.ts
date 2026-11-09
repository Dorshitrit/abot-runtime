import type { SparkHomeAppearanceReference } from "../appearance-reference.js";
import type { InformationBasketService } from "../../information-basket/contracts.js";
import type { LongTermMemoryService } from "../../long-term-memory/contracts.js";
import type { SessionStore } from "../../ports.js";
import type { SparkHomeReader } from "../contracts.js";
import type { SparkHomePlanningReference } from "./planning.js";

export type AuthoringContextDependencies = Readonly<{
  service: SparkHomeReader;
  sessions: Pick<SessionStore, "listSessions" | "getSessionSnapshot">;
  memory: Pick<LongTermMemoryService, "enabled" | "status" | "list"> & Readonly<{
    learning?: Pick<NonNullable<LongTermMemoryService["learning"]>, "list">;
  }>;
  resources?: Pick<InformationBasketService, "list" | "isReady">;
  now?: () => Date;
  timeZone?: string;
}>;

export type AuthoringContextInput = Readonly<{
  expectedRevision: number;
  requestId: string;
  abortSignal: AbortSignal;
  resourcesAccess: "allowed" | "blocked";
  appearance?: SparkHomeAppearanceReference;
}>;

export type SparkHomeAuthoringContext = Readonly<{
  planning: SparkHomePlanningReference;
  authoring: string;
  resourceBindings: readonly Readonly<{ sourceId: string; expectedRevision: number }>[];
}>;
export interface SparkHomeAuthoringContextProvider {
  capture(input: AuthoringContextInput): Promise<SparkHomeAuthoringContext>;
}

export type ReferenceEntry = Readonly<Record<string, unknown>>;
export type ReferenceSection<T extends ReferenceEntry = ReferenceEntry> = Readonly<{
  status: "available" | "empty" | "disabled" | "blocked" | "unavailable";
  reason?: string;
  entries: readonly T[];
  availableCount?: number;
  scannedCount?: number;
  omittedCount?: number;
  omittedByCount?: number;
  omittedByBudget?: number;
  omittedOutsideWindow?: number;
  characterBudget?: number;
  selection?: string;
}>;

export const AUTHORING_CONTEXT_LIMITS = Object.freeze({
  savedMemories: 24, passiveMemories: 24, candidates: 16,
  memoryScan: 500, ordinarySessions: 7, messagesPerSession: 6,
  resourceIndex: 40, resourceInspections: 3,
  resourceCharacters: 4000, totalResourceCharacters: 8000,
  savedCharacters: 4000, passiveCharacters: 4000,
  candidateCharacters: 3000, historyCharacters: 6000,
  resourceIndexCharacters: 5000,
  planningCharacters: 10 * 1024,
  planningMemoryCharacters: 4000, planningHistoryCharacters: 2000, planningResourceCharacters: 2500,
});
