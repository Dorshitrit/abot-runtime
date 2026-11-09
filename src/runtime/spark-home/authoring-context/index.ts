import { captureSparkHomeAppearanceReference } from "../appearance-reference.js";
import { isSparkHomeHtml, isSparkHomeRevision } from "../contracts.js";
import { AUTHORING_CONTEXT_LIMITS as limits, type AuthoringContextDependencies,
  type AuthoringContextInput, type SparkHomeAuthoringContextProvider } from "./contracts.js";
import { captureHistoryRecords } from "./history-records.js";
import { captureMemoryRecords } from "./memory-records.js";
import { projectAuthoringHistory } from "./history.js";
import { projectAuthoringMemories } from "./memories.js";
import { contextFailure, requireSource } from "./projection.js";
import { captureResourceIndex } from "./resources.js";
import { projectSparkHomePlanningContext } from "./planning.js";
import { captureSparkHomeHtmlReference } from "./html-reference.js";

/** One capture feeds phase-specific passive projections; no source body or ordinary conversation writes. */
export function createSparkHomeAuthoringContextProvider(dependencies: AuthoringContextDependencies): SparkHomeAuthoringContextProvider {
  return Object.freeze({
    async capture(input: AuthoringContextInput) {
      input.abortSignal.throwIfAborted();
      const now = dependencies.now?.() ?? new Date();
      const screen = await requireSource("screen", () => dependencies.service.read());
      input.abortSignal.throwIfAborted();
      if (!isSparkHomeRevision(input.expectedRevision) || screen.revision !== input.expectedRevision)
        contextFailure("screen_revision_conflict", "SPARK HOME changed since the selected revision.");
      if (screen.html !== null && !isSparkHomeHtml(screen.html))
        contextFailure("screen_invalid", "The saved SPARK HOME HTML is invalid or exceeds its supported size.");
      const [memories, history, resources] = await Promise.all([
        captureMemoryRecords(dependencies.memory, now), captureHistoryRecords(dependencies.sessions),
        captureResourceIndex(dependencies.resources, input),
      ]);
      input.abortSignal.throwIfAborted();
      const planning = projectSparkHomePlanningContext({ screen, memories, history, resources, requestId: input.requestId, now });
      const metadata = {
        kind: "spark_home_authoring_reference_v1", authority: "passive_reference",
        applicability: "this_requested_spark_home_update_only",
        addsUserIntent: false, grantsActionAuthority: false, establishesCompletion: false,
        historicalRequestsAreNotPendingWork: true,
        creationContext: { capturedAt: now.toISOString(), timeZone: dependencies.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone },
        ...(input.appearance ? { appearance: { ...captureSparkHomeAppearanceReference(input.appearance), mandatory: false } } : {}),
        memories: projectAuthoringMemories(memories), history: projectAuthoringHistory(history, input.requestId), resourceIndex: resources,
        resourceReadLimits: { maxSources: limits.resourceInspections,
          maxCharactersPerSource: limits.resourceCharacters, maxTotalCharacters: limits.totalResourceCharacters },
      };
      const authoring = captureSparkHomeHtmlReference(metadata, screen, input.expectedRevision)({
        status: "not_loaded", excerpts: [], reason: "Read captured indexed Resources only through approved planned read operations.",
      });
      return Object.freeze({ planning, authoring,
        resourceBindings: Object.freeze(resources.entries.map(({ sourceId, expectedRevision }) => Object.freeze({ sourceId, expectedRevision }))),
      });
    },
  });
}

export type { AuthoringContextDependencies, AuthoringContextInput,
  SparkHomeAuthoringContext, SparkHomeAuthoringContextProvider } from "./contracts.js";
export type { SparkHomePlanningReference } from "./planning.js";
