import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalRequestControls } from "../local-host/app-request-control.js";
import { processDebugLogger } from "../observability/debug-logger.js";
import { makeOwnerControlPeer } from "./support/local-runtime-owner-peer.js";

type RecordedTrace = {
  scope: string;
  event: string;
  fields: Record<string, unknown>;
};
const traces: RecordedTrace[] = [];

beforeEach(() => {
  traces.length = 0;
  vi.spyOn(processDebugLogger, "trace").mockImplementation(
    (scope, event, fields = {}) => {
      traces.push({ scope, event, fields });
    },
  );
});
afterEach(() => vi.restoreAllMocks());

function ownerTrace(event: string) {
  return traces.filter(
    (trace) =>
      trace.scope === "runtime.local_request_control" && trace.event === event,
  );
}

describe("local owner steering diagnostics", () => {
  it("correlates canonical inbox results and preserves acceptance, duplicate and sealed rejection", async () => {
    const controls = new LocalRequestControls(() => {});
    const options = controls.ordinary(
      "request",
      makeOwnerControlPeer("peer").peer,
      {},
      "session",
    );
    const input = { steerId: "steer", text: "PRIVATE_STEERING_CONTENT" };
    const accepted = controls.steer("request", input);
    expect(accepted).toEqual({
      ok: true,
      duplicate: false,
      update: { ...input, sequence: 1 },
    });
    expect(controls.steer("request", input)).toEqual({
      ...(accepted as object),
      duplicate: true,
    });
    expect(
      controls.steer("request", { ...input, text: "OTHER_PRIVATE_CONTENT" }),
    ).toEqual({ ok: false, reason: "steer_id_conflict" });
    expect(options.requestSteering!.seal(1)).toBe(true);
    expect(
      controls.steer("request", {
        steerId: "late",
        text: "LATE_PRIVATE_CONTENT",
      }),
    ).toEqual({ ok: false, reason: "request_not_active" });
    const inboxId = ownerTrace("control.opened")[0]!.fields.inboxId;
    expect(inboxId).toEqual(expect.any(String));
    expect(ownerTrace("steer.result").map(({ fields }) => fields)).toEqual([
      expect.objectContaining({
        inboxId,
        accepted: true,
        duplicate: false,
        acceptedSequence: 1,
      }),
      expect.objectContaining({
        inboxId,
        accepted: true,
        duplicate: true,
        acceptedSequence: 1,
      }),
      expect.objectContaining({
        inboxId,
        accepted: false,
        reason: "steer_id_conflict",
      }),
      expect.objectContaining({
        inboxId,
        accepted: false,
        reason: "request_not_active",
      }),
    ]);
    expect(traces).toContainEqual(
      expect.objectContaining({
        scope: "runtime.request_steering",
        event: "update.rejected",
        fields: expect.objectContaining({
          inboxId,
          inboxOrigin: "local_owner",
          closed: false,
          sealed: true,
        }),
      }),
    );
    controls.finish("request", "ordinary_handler_finally");
    await options.requestSteering!.close();
    expect(JSON.stringify(traces)).not.toContain("PRIVATE_CONTENT");
    expect(JSON.stringify(traces)).not.toContain(input.text);
  });

  it("distinguishes missing, cancelled and stopped controls without changing their lifetime", () => {
    const controls = new LocalRequestControls(() => {});
    const input = { steerId: "steer", text: "private" };
    expect(controls.steer("missing", input)).toEqual({
      ok: false,
      reason: "request_not_active",
    });
    controls.ordinary(
      "cancelled",
      makeOwnerControlPeer("peer").peer,
      {},
      "session",
    );
    expect(controls.cancel("cancelled", "session")).toEqual({ accepted: true });
    expect(controls.steer("cancelled", input)).toEqual({
      ok: false,
      reason: "request_not_active",
    });
    expect(controls.hasActiveRequest("cancelled", "session")).toBe(true);
    controls.finish("cancelled", "ordinary_handler_finally");
    expect(controls.hasActiveRequest("cancelled", "session")).toBe(false);
    controls.ordinary(
      "stopped",
      makeOwnerControlPeer("peer").peer,
      {},
      "session",
    );
    controls.stop();
    expect(controls.steer("stopped", input)).toEqual({
      ok: false,
      reason: "request_not_active",
    });
    expect(controls.hasActiveRequest("stopped", "session")).toBe(true);
    expect(ownerTrace("steer.rejected").map(({ fields }) => fields)).toEqual([
      expect.objectContaining({
        requestId: "missing",
        diagnosticReason: "control_missing",
        controlPresent: false,
      }),
      expect.objectContaining({
        requestId: "cancelled",
        diagnosticReason: "control_aborted",
        ownerStopped: false,
      }),
      expect.objectContaining({
        requestId: "stopped",
        diagnosticReason: "control_aborted",
        ownerStopped: true,
      }),
    ]);
    expect(ownerTrace("cancel.accepted")).toHaveLength(1);
    expect(ownerTrace("control.interrupted")).toHaveLength(1);
    expect(ownerTrace("control.finished")[0]!.fields).toMatchObject({
      requestId: "cancelled",
      source: "ordinary_handler_finally",
      aborted: true,
    });
    controls.finish("stopped");
  });

  it("records malformed-prefix cleanup and separates later resumed controls by inbox identity", () => {
    const controls = new LocalRequestControls(() => {});
    const peer = makeOwnerControlPeer("peer").peer;
    expect(() =>
      controls.ordinary(
        "request",
        peer,
        {
          steeringUpdates: [
            { steerId: "bad", text: undefined, sequence: 1 },
          ] as never,
        },
        "session",
      ),
    ).toThrow();
    expect(controls.hasActiveRequest("request", "session")).toBe(false);
    const resumedWait = {
      requestId: "request",
      generation: "generation",
      waitId: "wait",
      revision: 7,
    };
    const options = controls.ordinary(
      "request",
      peer,
      {},
      "session",
      resumedWait,
    );
    options.claimFinalization!();
    expect(controls.cancel("request", "session")).toEqual({
      accepted: false,
      reason: "request_not_active",
    });
    const [first, second] = ownerTrace("control.opened");
    expect(first!.fields.inboxId).not.toBe(second!.fields.inboxId);
    expect(ownerTrace("control.finished")[0]!.fields).toMatchObject({
      source: "initial_steering_rejected",
      inboxId: first!.fields.inboxId,
    });
    expect(ownerTrace("control.attached")[0]!.fields).toMatchObject({
      ...resumedWait,
      inboxId: second!.fields.inboxId,
    });
    expect(ownerTrace("finalization.claimed")[0]!.fields).toMatchObject({
      requestId: "request",
      inboxId: second!.fields.inboxId,
      finalizing: true,
    });
    controls.finish("request", "resumed_handler_finally");
  });

  it("keeps rejection and cleanup behavior when diagnostic logging throws", async () => {
    vi.mocked(processDebugLogger.trace).mockImplementation(() => {
      throw new Error("trace unavailable");
    });
    const controls = new LocalRequestControls(() => {});
    const options = controls.ordinary(
      "request",
      makeOwnerControlPeer("peer").peer,
      {},
      "session",
    );
    expect(
      controls.steer("request", { steerId: "steer", text: "private" }),
    ).toMatchObject({ ok: true });
    expect(controls.cancel("request", "session")).toEqual({ accepted: true });
    expect(
      controls.steer("request", { steerId: "late", text: "private" }),
    ).toEqual({ ok: false, reason: "request_not_active" });
    expect(() =>
      controls.finish("request", "ordinary_handler_finally"),
    ).not.toThrow();
    await options.requestSteering!.close();
    expect(controls.hasActiveRequest("request", "session")).toBe(false);
  });
});
