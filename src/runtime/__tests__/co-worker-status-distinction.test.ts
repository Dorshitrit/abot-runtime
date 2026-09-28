import { describe, expect, test } from "vitest";
import { buildLearningServiceStatus } from "../passive-learning/service-status.js";
import { learningFailureReason } from "../passive-learning/status-projection.js";
import { DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
import type { LearningBackgroundDependencies } from "../passive-learning/background-dependencies.js";
// @ts-expect-error Browser-only presentation has no declaration surface.
import { learningCoveragePresentation, learningFailurePresentation, learningIntroText, learningStateLabel } from "../../web-ui/app/components/passive-learning/presentation.js";
// @ts-expect-error Browser-only presentation has no declaration surface.
import { coWorkerActivityStates, coWorkerActivityTones, coWorkerAgentState } from "../../web-ui/app/components/passive-learning/agent-state.js";

async function projected(overrides: Partial<Parameters<typeof buildLearningServiceStatus>[0]> = {}) {
  return buildLearningServiceStatus({
    background: { memory: {}, model: {} } as LearningBackgroundDependencies,
    preferences: { ...DEFAULT_LEARNING_PREFERENCES, enabled: true, processingPaused: false, modelProfileId: "local" },
    history: [], state: "collecting", deviceId: "paired-computer", queued: [], dropped: 0, active: 0, concurrency: 1,
    ...overrides,
  });
}

describe("Co-worker collection and processing status", () => {
  test("keeps healthy collection authoritative when the learning model fails", async () => {
    const status = await projected({ processingReason: "learning_model_request_failed" });
    expect(status).toMatchObject({ state: "failed", reason: "learning_model_request_failed",
      collectionState: "collecting", processingReason: "learning_model_request_failed", deviceId: "paired-computer" });
    expect(status.collectionReason).toBeUndefined();
    expect(learningStateLabel(status)).toBe("Collecting");
    expect(learningCoveragePresentation(status).label).toBe("App content available");
    expect(learningIntroText(status)).toBe("Learning from visible computer activity.");
    expect(coWorkerActivityStates(status)).toMatchObject({ collection: ["Collecting", "No hours restriction"], processing: ["Needs attention", "No hours restriction"] });
    expect(coWorkerActivityTones(status)).toEqual({ collection: "active", processing: "attention", proactive: "off" });
    expect(coWorkerAgentState({ status })).toMatchObject({ mode: "attention", title: "Let’s check the learning model." });
    expect(learningFailurePresentation(status)).toEqual({
      message: "The learning model could not process activity. Check its configuration in Settings.", connectComputer: false,
    });
  });

  test("preserves partial collection coverage independently of a processing failure", async () => {
    const status = await projected({ state: "partial", reason: "accessibility_read_unavailable", processingReason: "output_incomplete" });
    expect(status.collectionReason).toBe("accessibility_read_unavailable");
    expect(learningStateLabel(status)).toBe("Limited access");
    expect(learningCoveragePresentation(status).label).toBe("Some content unreadable");
    expect(coWorkerActivityTones(status)).toMatchObject({ collection: "active", processing: "attention" });
  });

  test("still reports actual collection failures and accepts legacy status snapshots", async () => {
    const status = await projected({ state: "disconnected", reason: "host_disconnected" });
    expect(learningStateLabel(status)).toBe("Disconnected");
    expect(learningFailurePresentation(status).connectComputer).toBe(true);
    expect(coWorkerActivityTones(status)).toMatchObject({ collection: "attention", processing: "ready" });
    const { collectionState: _state, collectionReason: _reason, ...legacy } = status;
    expect(learningStateLabel(legacy)).toBe("Disconnected");
    expect(learningFailurePresentation(legacy).connectComputer).toBe(true);
  });

  test("classifies model gateway HTTP failures without exposing the response body", () => {
    const error = new Error("bridge_request_failed:500:private observed text and api_key=secret");
    expect(learningFailureReason(error)).toBe("learning_model_request_failed");
    expect(learningFailureReason(new Error("learning_model_request_failed"))).toBe("learning_model_request_failed");
    expect(learningFailureReason(new Error("other private error"))).toBe("learning_failed");
  });
});
