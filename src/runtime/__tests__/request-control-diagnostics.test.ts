import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createRequestControlDiagnosticId,
  diagnosticErrorType,
  traceRequestControl,
} from "../observability/request-control-diagnostics.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";

const { traceDebug } = vi.hoisted(() => ({ traceDebug: vi.fn() }));
vi.mock("../observability/debug-logger.js", () => ({ traceDebug }));

afterEach(() => traceDebug.mockReset());

function events(name: string) {
  return traceDebug.mock.calls
    .filter(([, event]) => event === name)
    .map(([, , fields]) => fields);
}

describe("request control diagnostics", () => {
  test("correlates processes and records available package identity without payloads", () => {
    traceRequestControl("test", "received", { requestId: "r", steerId: "s" });
    traceRequestControl("test", "result", { requestId: "r", steerId: "s" });
    const first = events("received")[0];
    expect(first).toMatchObject({
      requestId: "r",
      steerId: "s",
      pid: process.pid,
    });
    expect(first.runtimeVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(first.processInstanceId).toBe(events("result")[0].processInstanceId);
    expect(createRequestControlDiagnosticId("inbox")).not.toBe(
      createRequestControlDiagnosticId("inbox"),
    );
    expect(diagnosticErrorType(new TypeError("private text"))).toBe(
      "TypeError",
    );
    expect(JSON.stringify(traceDebug.mock.calls)).not.toContain("private text");
  });

  test("classifies errors without reading or logging caller-controlled names", () => {
    const error = new Error("private message");
    error.name = "Private customer acquisition plan";
    traceRequestControl("test", "failed", {
      errorType: diagnosticErrorType(error),
    });
    expect(events("failed")).toEqual([
      expect.objectContaining({ errorType: "Error" }),
    ]);
    expect(JSON.stringify(traceDebug.mock.calls)).not.toContain(error.name);
    expect(JSON.stringify(traceDebug.mock.calls)).not.toContain(error.message);

    const name = vi.fn(() => {
      throw new Error("name must not be read");
    });
    const typed = Object.defineProperty(new TypeError(), "name", { get: name });
    expect(diagnosticErrorType(typed)).toBe("TypeError");
    expect(name).not.toHaveBeenCalled();
  });

  test("isolates synchronous logger failure from control and persistence outcomes", async () => {
    traceDebug.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const inbox = createRequestSteeringInbox({ requestId: "r" });
    const persist = vi.fn(async () => {});
    inbox.bindPersistence(persist);
    const update = { steerId: "s", text: "private instruction" };
    expect(inbox.append(update)).toEqual({
      ok: true,
      duplicate: false,
      update: { ...update, sequence: 1 },
    });
    expect(inbox.seal(1)).toBe(true);
    expect(
      inbox.append({ steerId: "late", text: "later instruction" }),
    ).toEqual({ ok: false, reason: "request_not_active" });
    await expect(inbox.close()).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledExactlyOnceWith({ ...update, sequence: 1 });
  });

  test("separates inbox instances sharing a request and preserves duplicate semantics", async () => {
    const projection = createRequestSteeringInbox({
      requestId: "r",
      diagnostics: { origin: "web_projection" },
    });
    const owner = createRequestSteeringInbox({
      requestId: "r",
      diagnostics: { origin: "local_owner", inboxId: "owner-inbox" },
    });
    const [localOpened, ownerOpened] = events("inbox.opened");
    expect(localOpened.inboxId).not.toBe(ownerOpened.inboxId);
    expect(ownerOpened).toMatchObject({
      inboxId: "owner-inbox",
      inboxOrigin: "local_owner",
    });
    await projection.close();
    const input = { steerId: "s", text: "secret instruction" };
    expect(owner.append(input).ok).toBe(true);
    expect(owner.seal(1)).toBe(true);
    expect(owner.append(input)).toMatchObject({ ok: true, duplicate: true });
    expect(owner.append({ ...input, text: "conflict" })).toEqual({
      ok: false,
      reason: "steer_id_conflict",
    });
    expect(owner.append({ steerId: "late", text: "late" })).toEqual({
      ok: false,
      reason: "request_not_active",
    });
    expect(events("update.rejected").at(-1)).toMatchObject({
      inboxId: "owner-inbox",
      closed: false,
      sealed: true,
      steerId: "late",
    });
    expect(JSON.stringify(traceDebug.mock.calls)).not.toContain(input.text);
    await owner.close();
  });

  test("records closure at its boundary while accepted persistence is still pending", async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inbox = createRequestSteeringInbox({ requestId: "r" });
    inbox.bindPersistence(() => persisted);
    inbox.append({ steerId: "accepted", text: "secret" });
    const closing = inbox.close();
    expect(events("inbox.closing")).toHaveLength(1);
    expect(events("inbox.closed")).toHaveLength(0);
    expect(inbox.append({ steerId: "late", text: "late" })).toEqual({
      ok: false,
      reason: "request_not_active",
    });
    expect(events("update.rejected").at(-1)).toMatchObject({
      closed: true,
      sealed: true,
    });
    release();
    await closing;
    expect(events("update.persisted")).toHaveLength(1);
    expect(events("inbox.closed")).toHaveLength(1);
  });
});
