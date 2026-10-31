import { describe, expect, test, vi } from "vitest";
import { createRequestCallbacks } from "../streaming/request-callbacks.js";
import type { EventSink } from "../ports.js";
import { createRequestUserInteractions } from "../user-interactions/request-service.js";
import {
  USER_INTERACTION_EVENT_NAME, USER_INTERACTION_RECEIPT_LIMIT,
  USER_INTERACTION_TEXT_MAX_LENGTH, type UserInteractionBinding,
} from "../user-interactions/contracts.js";

const binding = (activationCount = 1): UserInteractionBinding => ({
  callId: "root-call", activationCount, steeringVersion: 0,
});
const message = { kind: "message" as const, text: "בדקתי את המבנה. עכשיו אעדכן את הקובץ." };

describe("request-owned user interactions", () => {
  test("publishes one immutable complete message with Runtime identity", () => {
    const event = vi.fn();
    const service = createRequestUserInteractions({ requestId: "request-a", events: { event } });
    expect(service.snapshot()).toBeUndefined();
    expect(service.projectContext()).toBeUndefined();
    service.publish(message, binding());
    expect(event).toHaveBeenCalledExactlyOnceWith(USER_INTERACTION_EVENT_NAME, {
      interaction: {
        version: 1, kind: "message", requestId: "request-a",
        interactionId: "request-a:interaction:1", sequence: 1,
        createdAt: expect.any(String), payload: { text: message.text }, origin: binding(),
      },
    });
    const receipt = service.snapshot()!.recent[0]!;
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.payload)).toBe(true);
    expect(Object.isFrozen(receipt.origin)).toBe(true);
    expect(service.projectContext()!.content).toContain(message.text);
  });

  test("reuses an accepted binding across restoration and rejects conflicting text", () => {
    const event = vi.fn();
    const original = createRequestUserInteractions({ requestId: "r", events: { event } });
    original.publish(message, binding());
    const service = createRequestUserInteractions({
      requestId: "r", events: { event }, restored: JSON.parse(JSON.stringify(original.snapshot())),
    });
    service.publish(message, binding());
    expect(event).toHaveBeenCalledTimes(1);
    expect(() => service.publish({ ...message, text: "different" }, binding()))
      .toThrow("user_interaction_publication_conflict");
    service.publish(message, binding(2));
    expect(service.snapshot()!.publishedCount).toBe(2);
    expect(service.snapshot()!.recent[1]!.interactionId).toBe("r:interaction:2");
  });

  test("retains a bounded exact tail and declares the omitted receipts", () => {
    const event = vi.fn();
    const service = createRequestUserInteractions({ requestId: "r", events: { event } });
    for (let i = 1; i <= USER_INTERACTION_RECEIPT_LIMIT + 3; i++)
      service.publish({ ...message, text: `update ${i}` }, binding(i));
    const snapshot = service.snapshot()!;
    expect(snapshot.recent).toHaveLength(USER_INTERACTION_RECEIPT_LIMIT);
    expect(snapshot.recent[0]!.sequence).toBe(4);
    const context = JSON.parse(service.projectContext()!.content as string);
    expect(context).toMatchObject({
      kind: "runtime_user_interaction_receipts_v1", authority: "assistant_communication",
      publishedCount: USER_INTERACTION_RECEIPT_LIMIT + 3, omittedCount: 3,
    });
    expect(event).toHaveBeenCalledTimes(USER_INTERACTION_RECEIPT_LIMIT + 3);
    expect(createRequestUserInteractions({
      requestId: "r", events: { event }, restored: snapshot,
    }).snapshot()).toEqual(snapshot);
  });

  test.each(["", "  ", "x".repeat(USER_INTERACTION_TEXT_MAX_LENGTH + 1)])(
    "rejects invalid message content before publication", (text) => {
      const event = vi.fn();
      const service = createRequestUserInteractions({ requestId: "r", events: { event } });
      expect(() => service.publish({ kind: "message", text }, binding())).toThrow();
      expect(event).not.toHaveBeenCalled();
      expect(service.snapshot()).toBeUndefined();
    },
  );

  test("does not create a receipt when the existing sink rejects publication", () => {
    const failure = new Error("transport failed");
    const service = createRequestUserInteractions({
      requestId: "r", events: { event: () => { throw failure; } },
    });
    expect(() => service.publish(message, binding())).toThrow(failure);
    expect(service.snapshot()).toBeUndefined();
  });

  test("rejects cross-request and malformed continuation receipts during construction", () => {
    const service = createRequestUserInteractions({ requestId: "r", events: { event: vi.fn() } });
    service.publish(message, binding());
    const stored = JSON.parse(JSON.stringify(service.snapshot()));
    expect(() => createRequestUserInteractions({
      requestId: "other", events: { event: vi.fn() }, restored: stored,
    })).toThrow("user_interaction_receipt_binding_invalid");
    expect(() => createRequestUserInteractions({
      requestId: "r", events: { event: vi.fn() }, restored: { ...stored, publishedCount: 2 },
    })).toThrow("user_interaction_snapshot_receipts_invalid");
    stored.recent[0].origin.activationCount = 0;
    expect(() => createRequestUserInteractions({
      requestId: "r", events: { event: vi.fn() }, restored: stored,
    })).toThrow("user_interaction_receipt_origin_invalid");
  });

  test("restored origin projects only declared canonical binding fields", () => {
    const original = createRequestUserInteractions({ requestId: "r", events: { event: vi.fn() } });
    original.publish(message, binding());
    const stored = JSON.parse(JSON.stringify(original.snapshot()));
    stored.recent[0].origin.extraInstructions = "Unexpected unbounded passive text";
    const restored = createRequestUserInteractions({
      requestId: "r", events: { event: vi.fn() }, restored: stored,
    });
    expect(restored.snapshot()!.recent[0]!.origin).toEqual(binding());
    expect(restored.projectContext()!.content).not.toContain("extraInstructions");
  });

  test("keeps messages out of answer and thinking text and restores old snapshots", () => {
    const sink = {
      event: vi.fn(), thinkingDelta: vi.fn(), legacyToken: vi.fn(),
    } as unknown as EventSink;
    const oldSnapshot = { answerText: "", thinkingText: "", thinkingTrace: [] };
    const callbacks = createRequestCallbacks(sink, "r", oldSnapshot);
    expect(callbacks.snapshot()).toEqual(oldSnapshot);
    callbacks.userInteractions.publish(message, binding());
    expect(callbacks.getAnswerText()).toBe("");
    expect(callbacks.getThinkingTrace()).toBeUndefined();
    expect(sink.thinkingDelta).not.toHaveBeenCalled();
    expect(sink.legacyToken).not.toHaveBeenCalled();
    const restored = createRequestCallbacks(sink, "r", callbacks.snapshot());
    restored.onAnswerToken("Exact final.\n");
    expect(restored.getAnswerText()).toBe("Exact final.\n");
    expect(restored.userInteractions.snapshot()).toEqual(callbacks.userInteractions.snapshot());
  });
});
