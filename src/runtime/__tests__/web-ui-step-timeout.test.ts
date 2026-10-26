import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module.
import { createStepTimeoutController } from "../../web-ui/app/controllers/step-timeout-controller.js";
// @ts-expect-error Browser-only JavaScript module.
import { createStepTimeoutNotice } from "../../web-ui/app/components/step-timeout-notice.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import { isLowValueActivityEvent } from "../../web-ui/app/lib/event-presentation.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

const identity = { environment: "dev", sessionId: "session", requestId: "request", invocationId: "call" };
const event = { type: "event", name: "model.step.timed_out", environment: "dev", sessionId: "session", requestId: "request", payload: { invocationId: "call", modelStep: "tool_payload.raw" } };
const suggestion = { configurationProfileId: "luna", profileId: "luna", model: "model", modelStep: "tool_payload.raw", timeoutMs: 90000, proposedTimeoutMs: 180000, canIncrease: true, revision: "revision" };

function fixture() {
  const scope = { backend: "runtime", workspace: "chat", environment: "dev", sessionId: "session", viewVersion: 0 };
  const client = {
    inspectStepTimeout: vi.fn(async (_identity: unknown) => ({ ok: true, suggestion })),
    increaseStepTimeout: vi.fn(async (_identity: unknown, _revision: unknown) => ({ ok: true, status: "saved" })),
    applyRuntimeConfiguration: vi.fn(async (_environment: string) => ({ activation: { status: "ready", message: "" } })),
  };
  const render = vi.fn();
  const onApplied = vi.fn();
  const controller = createStepTimeoutController({ client, getScope: () => ({ ...scope }), render, onApplied });
  return { scope, client, render, controller, onApplied };
}

describe("passive model step timeout suggestion", () => {
  test("recognizes the scoped event without saving, restarting or adding conversation activity", async () => {
    const f = fixture();
    await f.controller.handle(event);
    expect(f.client.inspectStepTimeout).toHaveBeenCalledWith(identity);
    expect(f.render).toHaveBeenLastCalledWith(expect.objectContaining({ suggestion, busy: false }));
    expect(f.client.increaseStepTimeout).not.toHaveBeenCalled();
    expect(f.client.applyRuntimeConfiguration).not.toHaveBeenCalled();
    expect(isLowValueActivityEvent(event)).toBe(true);
  });

  test.each([
    { name: "request.failed", error: "ETIMEDOUT" },
    { name: "tool.failed", error: "model_step_timeout" },
    { environment: "prod" }, { sessionId: "elsewhere" }, { requestId: "" },
    { sessionId: "" }, { environment: "" },
  ])("ignores unrelated errors and other conversations %j", async (override) => {
    const f = fixture();
    await f.controller.handle({ ...event, ...override });
    expect(f.client.inspectStepTimeout).not.toHaveBeenCalled();
  });

  test.each(["bridge", "home"])("does not surface outside Runtime chat: %s", async (value) => {
    const f = fixture();
    if (value === "bridge") f.scope.backend = value;
    else f.scope.workspace = value;
    await f.controller.handle(event);
    expect(f.client.inspectStepTimeout).not.toHaveBeenCalled();
  });

  test("dismissal and duplicate live delivery never reopen the same invocation", async () => {
    const f = fixture();
    await f.controller.handle(event);
    f.controller.dismiss();
    await f.controller.handle(event);
    expect(f.client.inspectStepTimeout).toHaveBeenCalledOnce();
    expect(f.render).toHaveBeenLastCalledWith(null);
  });

  test("double click saves once, then uses the existing activation route", async () => {
    const f = fixture();
    await f.controller.handle(event);
    await Promise.all([f.controller.increase(), f.controller.increase()]);
    expect(f.client.increaseStepTimeout).toHaveBeenCalledExactlyOnceWith(identity, "revision");
    expect(f.client.applyRuntimeConfiguration).toHaveBeenCalledExactlyOnceWith("dev");
    expect(f.onApplied).toHaveBeenCalledOnce();
    expect(f.client.increaseStepTimeout.mock.invocationCallOrder[0]).toBeLessThan(f.client.applyRuntimeConfiguration.mock.invocationCallOrder[0]!);
  });

  test("busy restart preserves the save and retry never doubles again", async () => {
    const f = fixture();
    f.client.applyRuntimeConfiguration.mockResolvedValueOnce({ activation: { status: "restart_required", message: "Agent is working." } });
    await f.controller.handle(event);
    await f.controller.increase();
    expect(f.onApplied).not.toHaveBeenCalled();
    expect(f.render).toHaveBeenLastCalledWith(expect.objectContaining({ saved: true, applied: false, message: "Saved. Agent is working." }));
    await f.controller.increase();
    expect(f.client.increaseStepTimeout).toHaveBeenCalledOnce();
    expect(f.onApplied).toHaveBeenCalledOnce();
  });

  test("save conflicts cannot restart Runtime", async () => {
    const f = fixture();
    f.client.increaseStepTimeout.mockRejectedValue(new Error("Configuration changed."));
    await f.controller.handle(event);
    await f.controller.increase();
    expect(f.client.applyRuntimeConfiguration).not.toHaveBeenCalled();
    expect(f.render).toHaveBeenLastCalledWith(expect.objectContaining({ saved: false, message: "Configuration changed." }));
  });

  test("a catalog refresh error does not undo the confirmed restart receipt", async () => {
    const f = fixture();
    f.onApplied.mockRejectedValue(new Error("Catalog unavailable"));
    await f.controller.handle(event);
    await f.controller.increase();
    expect(f.render).toHaveBeenLastCalledWith(expect.objectContaining({ applied: true, message: expect.stringContaining("Runtime restarted") }));
  });

  test.each(["sessionId", "environment", "workspace"])("navigation through %s invalidates pending preview and save even after return", async (field) => {
    const f = fixture();
    let releasePreview!: (value: any) => void;
    f.client.inspectStepTimeout.mockImplementationOnce(() => new Promise((resolve) => { releasePreview = resolve; }));
    const preview = f.controller.handle(event);
    const key = field as "sessionId" | "environment" | "workspace";
    const original = f.scope[key];
    f.scope[key] = "elsewhere"; f.controller.syncScope();
    f.scope[key] = original; f.controller.syncScope();
    releasePreview({ ok: true, suggestion }); await preview;
    expect(f.render).toHaveBeenLastCalledWith(null);

    await f.controller.handle({ ...event, payload: { ...event.payload, invocationId: "next" } });
    let releaseSave!: (value: any) => void;
    f.client.increaseStepTimeout.mockImplementationOnce(() => new Promise((resolve) => { releaseSave = resolve; }));
    const save = f.controller.increase();
    f.scope[key] = "elsewhere"; f.controller.syncScope();
    f.scope[key] = original; f.controller.syncScope();
    releaseSave({ ok: true }); await save;
    expect(f.client.applyRuntimeConfiguration).not.toHaveBeenCalled();
  });

  test("manual-only targets cannot be mutated by the action", async () => {
    const f = fixture();
    f.client.inspectStepTimeout.mockResolvedValue({ ok: true, suggestion: { ...suggestion, canIncrease: false } });
    await f.controller.handle(event);
    await f.controller.increase();
    expect(f.client.increaseStepTimeout).not.toHaveBeenCalled();
  });

  test("clearing or reloading the same conversation invalidates a pending save", async () => {
    const f = fixture();
    await f.controller.handle(event);
    let releaseSave!: (value: any) => void;
    f.client.increaseStepTimeout.mockImplementationOnce(() => new Promise((resolve) => { releaseSave = resolve; }));
    const save = f.controller.increase();
    f.scope.viewVersion += 1;
    f.controller.syncScope();
    releaseSave({ ok: true }); await save;
    expect(f.render).toHaveBeenLastCalledWith(null);
    expect(f.client.applyRuntimeConfiguration).not.toHaveBeenCalled();
  });
});

test("notice preserves composer focus and renders model content as text", () => {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.body = document.createElement("body");
  const composer = document.createElement("textarea");
  document.body.append(composer); composer.focus();
  const onDismiss = vi.fn();
  const notice = createStepTimeoutNotice({ documentRoot: document, onIncrease: vi.fn(), onDismiss, onSettings: vi.fn() });
  notice.render({ suggestion: { ...suggestion, model: "<script>unsafe</script>" }, busy: false, saved: false, applied: false, message: "" });
  expect(document.activeElement).toBe(composer);
  expect(document.body.querySelector("script")).toBeNull();
  expect(document.body.textContent).toContain("90s → 180s");
  document.body.querySelector(".step-timeout-dismiss")!.dispatch("click");
  expect(onDismiss).toHaveBeenCalledOnce();
  notice.dispose();
});

test("timeout transport sends only identity and revision, with encoded scope", async () => {
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => new Response(JSON.stringify({ ok: true, suggestion })));
  const config = { backend: "runtime", apiBasePath: "/web-api" };
  const client = createRuntimeWebClient({ getConfig: () => config, getEnvironmentId: () => "dev", origin: "http://localhost", fetchImpl });
  await client.inspectStepTimeout({ ...identity, sessionId: "a&b" });
  expect(fetchImpl.mock.calls[0]?.[0]).toBe("/web-api/runtime/config/step-timeout?environment=dev&sessionId=a%26b&requestId=request&invocationId=call");
  await client.increaseStepTimeout(identity, "revision");
  expect(fetchImpl.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST", body: JSON.stringify({ ...identity, expectedRevision: "revision" }) }));
  config.backend = "bridge";
  expect(() => client.inspectStepTimeout(identity)).toThrow("local Runtime");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
