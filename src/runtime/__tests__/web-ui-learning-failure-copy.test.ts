import { describe, expect, test, vi } from "vitest";
import { learningFailureReason } from "../passive-learning/status-projection.js";
// @ts-expect-error Browser-only presentation has no declaration surface.
import { learningFailureCopy } from "../../web-ui/app/components/passive-learning/failure-copy.js";
// @ts-expect-error Browser-only presentation has no declaration surface.
import { learningFailurePresentation } from "../../web-ui/app/components/passive-learning/presentation.js";
// @ts-expect-error Browser-only component has no declaration surface.
import { renderLearningBatchDetail } from "../../web-ui/app/components/passive-learning/batch-detail.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser-only controller has no declaration surface.
import { createPassiveLearningController } from "../../web-ui/app/controllers/passive-learning-controller.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

function renderFailure(reason?: string, status = "failed") {
  const documentRoot: { createElement?: (tag: string) => FakeElement } = {};
  documentRoot.createElement = tag => new FakeElement(tag, documentRoot as never);
  const container = new FakeElement("div", documentRoot as never);
  renderLearningBatchDetail(container, { selectedBatchId: "batch", selectedBatch: {
    id: "batch", status, reason, observations: [], recordIds: [],
  } });
  return container;
}

test.each(["learning_activity_not_allowed", "learning_model_required", "proactive_model_required", "Access denied"])(
  "shows actionable configure failure copy through the HTTP client and controller: %s", async (reason) => {
    const client = createRuntimeWebClient({
      getConfig: () => ({ apiBasePath: "/web-api", backend: "runtime" }),
      getEnvironmentId: () => "dev", origin: "http://localhost:5177",
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: reason }), { status: 400 })),
    });
    const controller = createPassiveLearningController({ client, getEnvironmentId: () => "dev", render: vi.fn(), isVisible: () => false });
    await controller.configure({ enabled: true });
    const explanation = learningFailureCopy(reason);
    expect(controller.snapshot().statusError).toBe(explanation.code ? explanation.message : reason);
    expect(controller.snapshot().status).toBeNull();
    expect(controller.snapshot().saving).toBe(false);
  },
);

describe("friendly learning failure reasons", () => {
  test.each([
    ["learning_decision_target_unknown", "could not be found"],
    ["learning_create_target_invalid", "invalid request to create a new candidate"],
    ["learning_review_output_contract_invalid", "missing or unsupported fields"],
    ["learning_score_invalid", "invalid candidate score"],
    ["learning_content_sensitive", "sensitive information"],
    ["long_term_memory_embedding_response_invalid", "embedding provider"],
    ["co_worker_model_daily_budget_exhausted", "daily model-call limit"],
    ["learning_batch_timeout", "time limit"],
    ["learning_review_progress_storage_unavailable", "Review progress could not be saved"],
    ["learning_review_progress_capacity", "Review progress could not be saved"],
    ["learning_review_progress_invalid", "could not be read safely"],
    ["learning_review_progress_expired", "retention limit"],
    ["request_context_final_envelope_exceeds_window", "Choose a model with a larger context window"],
    ["request_context_required_content_exceeds_budget", "Choose a model with a larger context window"],
    ["learning_review_context_exceeds_budget", "Choose a model with a larger context window"],
    ["learning_partition_capacity", "waiting for queue space to split safely"],
    ["learning_output_invalid_json", "unreadable response format"],
    ["learning_output_object_required", "wrong response structure"],
    ["learning_output_decisions_missing", "did not include its learning decisions"],
    ["learning_output_decisions_not_array", "learning decisions in the wrong format"],
    ["learning_output_decision_limit", "more learning decisions than this review allows"],
  ])("uses the same explanation for the main notice and batch details: %s", (reason, message) => {
    expect(learningFailureReason(new Error(reason))).toBe(reason);
    const main = learningFailurePresentation({ preferences: { enabled: true }, state: "failed", collectionState: "collecting", processingReason: reason });
    const detail = renderFailure(reason);
    expect(main.message).toContain(message);
    expect(detail.querySelector(".passive-learning-detail-reason")?.textContent).toBe(main.message);
    const technical = detail.querySelector("details")!;
    expect(technical.open).toBe(false);
    expect(technical.querySelector("summary")?.textContent).toBe("Technical details");
    expect(technical.querySelector("code")?.textContent).toBe(reason);
    expect(technical.querySelector("dd")?.textContent).toBe(main.message);
  });

  test.each([
    '<img src=x onerror="alert(1)"> private captured text api_key=secret',
    "bridge_request_failed:500:private provider response",
    "learning_score_invalid:private suffix",
    "request_context_final_envelope_exceeds_window:private provider body",
    "request_context_required_content_exceeds_budget:private captured text",
    "learning_review_context_exceeds_budget:private model input",
    "learning_output_invalid_json:private model output",
    "learning_output_object_required:private model output",
    "learning_output_decisions_missing:private model output",
    "learning_output_decisions_not_array:private model output",
    "learning_output_decision_limit:private model output",
    "learning_review_output_contract_invalid:private model output",
    "learning_review_progress_invalid:private model output",
    "constructor",
  ])("never renders an unknown reason or provider body: %s", reason => {
    expect(learningFailureReason(new Error(reason))).not.toBe(reason);
    const copy = learningFailureCopy(reason);
    const detail = renderFailure(reason);
    const main = learningFailurePresentation({ preferences: { enabled: true }, state: "failed", processingReason: reason });
    expect(copy).toEqual({ message: learningFailureCopy("learning_failed").message, code: null });
    expect(main.message).toBe(copy.message);
    expect(detail.textContent).not.toContain(reason);
    expect(detail.querySelector("code")).toBe(null);
    expect(detail.outerHTML).not.toContain("<img");
  });

  test("keeps old generic failures truthful without inventing a specific cause", () => {
    const main = learningFailureCopy("learning_failed");
    expect(main.message).toContain("No specific cause is available");
    expect(renderFailure().textContent).toContain(main.message);
    expect(main.code).toBe("learning_failed");
  });

  test("presents partitioned pending activity as waiting, without a failure notice", () => {
    const detail = renderFailure("learning_batch_partitioned", "pending");
    expect(detail.querySelector(".passive-learning-detail-header")?.textContent).toContain("Waiting");
    expect(detail.querySelector(".passive-learning-detail-reason")?.textContent)
      .toBe("Waiting in smaller batches to fit the selected model.");
    expect(detail.textContent).not.toContain("Failed");
    expect(detail.querySelector("details")?.open).toBe(false);
    expect(detail.querySelector("code")?.textContent).toBe("learning_batch_partitioned");
    expect(learningFailurePresentation({ state: "collecting", collectionState: "collecting",
      preferences: { enabled: true }, pendingObservations: 2 })).toBe(null);
  });

  test("presents application-excluded activity as pending, without an invented failure", () => {
    const detail = renderFailure("learning_application_processing_excluded", "pending");
    expect(detail.querySelector(".passive-learning-detail-header")?.textContent).toContain("Waiting");
    expect(detail.querySelector(".passive-learning-detail-reason")?.textContent)
      .toContain("processing is turned off for an application");
    expect(detail.textContent).toContain("expiry and storage limits");
    expect(detail.textContent).not.toContain("Failed");
    expect(detail.querySelector("details")?.open).toBe(false);
    expect(detail.querySelector("code")?.textContent).toBe("learning_application_processing_excluded");
  });

});


test.each(["macos_accessibility_permission_required", "macos_accessibility_permission_timeout", "macos_accessibility_permission_revoked"])(
  "offers computer permission setup for the precise Mac collection failure: %s", reason => {
    const main = learningFailurePresentation({ preferences: { enabled: true },
      state: "permission_required", collectionState: "permission_required", collectionReason: reason });
    expect(main.connectComputer).toBe(true);
    expect(main.message).toBe(learningFailureCopy(reason).message);
    expect(learningFailureCopy(reason).code).toBe(reason);
    expect(learningFailurePresentation({ preferences: { enabled: false },
      collectionState: "permission_required", collectionReason: reason })).toBe(null);
  },
);
